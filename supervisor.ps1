# 家·Supervisor（supervisor-design.md v2.3 一期正式版，取代 watchdog-home.ps1 / restart-home.ps1）
# 用法：已配开机自启（启动文件夹"家-Supervisor.lnk"，最小化到任务栏），一般不用手动开。
#       手动开：右键此文件 →"使用 PowerShell 运行"，窗口一直开着（可最小化，别关）。
# 它干的事：
#   1. 每 5 秒查健康端点+端口；活着同一行刷心跳，死了退避拉起（5/15/60 秒，10 次封顶转人工）
#   2. 处理 restart.request：抢占 → drain 拿锁 20 秒一续 → 等 restartReady → 核身杀树 → 拉新代 → nonce 认领
#   3. 只杀自己登记过的 PID（核创建时间防复用），绝不杀自己和祖先链；手动起的服务只监控不认领
#   4. 一切生死写 supervisor.log
# 铁律：本文件必须 UTF-8 带 BOM 保存（PowerShell 5.1 无 BOM 会按 GBK 解析中文注释炸假语法错误）。
param([int]$Port = 3000, [int]$IntervalSec = 5)
$ErrorActionPreference = 'SilentlyContinue'
$HomeDir = $PSScriptRoot
$LogFile = Join-Path $HomeDir 'supervisor.log'
$ReqFile = Join-Path $HomeDir 'restart.request'
$ProcFile = Join-Path $HomeDir 'restart.request.processing'
$OwnedFile = Join-Path $HomeDir 'data\runtime\supervisor-owned.json'
$BaseUrl = "http://127.0.0.1:$Port"
$host.UI.RawUI.WindowTitle = '家·Supervisor（别关我）'

# 单实例锁：开机自启+手动双开时，后来的直接退（防两个 Supervisor 抢着拉服务打架）
$script:SingletonMutex = New-Object System.Threading.Mutex($false, 'Global\Home-Supervisor-Singleton')
$gotLock = $false
try { $gotLock = $script:SingletonMutex.WaitOne(0) } catch { $gotLock = $true }  # AbandonedMutex：前任没释放就死了，锁归我
if (-not $gotLock) {
  Write-Host '已有一个 Supervisor 在跑（可能最小化在任务栏），这个窗口不干活，10 秒后自动关' -ForegroundColor Yellow
  Start-Sleep -Seconds 10
  exit
}

# ---------- 基础 ----------
function Log($msg, $color) {
  if (-not $color) { $color = 'Gray' }
  $line = "[{0}] {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $msg
  Write-Host ''
  Write-Host $line -ForegroundColor $color
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}
function Beep-Alarm { [console]::beep(880, 500) }
function Beep-Ok { [console]::beep(1320, 300) }
function Beep-Manual { 1..3 | ForEach-Object { [console]::beep(660, 400); Start-Sleep -Milliseconds 150 } }
function New-Nonce { [guid]::NewGuid().ToString('N') }

function Get-ServicePid {
  $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($conn) { return [int](($conn | Select-Object -First 1).OwningProcess) }
  return $null
}
function Get-Health {
  # 三态：健康对象=新代码正常；@{legacy=true}=HTTP 有响应但没这端点（旧代码），进程活着不算僵死；
  # $null=超时/连接拒绝，才是真没响应
  try { return Invoke-RestMethod -Uri "$BaseUrl/api/supervisor/status" -TimeoutSec 4 -ErrorAction Stop } catch {
    if ($_.Exception.Response) { return [pscustomobject]@{ legacy = $true } }
    return $null
  }
}
function Send-Drain($requestId, $nonce, $leaseSeconds) {
  $body = @{ requestId = $requestId; nonce = $nonce; leaseSeconds = $leaseSeconds } | ConvertTo-Json -Compress
  try {
    return Invoke-RestMethod -Uri "$BaseUrl/api/supervisor/drain" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 4 -ErrorAction Stop
  } catch { return $null }
}
function Get-AncestorPids {
  $chain = @(); $current = $PID
  while ($current -and $chain.Count -lt 20) {
    $chain += [int]$current
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
    if (-not $proc) { break }
    $current = $proc.ParentProcessId
    if ($chain -contains [int]$current) { break }
  }
  return $chain
}
function Write-AtomicJson($path, $obj) {
  $tmp = "$path.tmp"
  $obj | ConvertTo-Json -Compress | Set-Content -Path $tmp -Encoding UTF8
  Move-Item -Path $tmp -Destination $path -Force
}

# ---------- 认领登记（落盘，Supervisor 自己重启后凭它找回重启权） ----------
$script:Owned = $null   # @{ Pid; StartTime(ISO); Nonce }
function Save-Owned {
  $dir = Split-Path $OwnedFile -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if ($script:Owned) { Write-AtomicJson $OwnedFile $script:Owned }
  elseif (Test-Path $OwnedFile) { Remove-Item $OwnedFile -Force }
}
function Restore-Owned {
  if (-not (Test-Path $OwnedFile)) { return }
  $saved = $null
  try { $saved = Get-Content $OwnedFile -Raw | ConvertFrom-Json } catch { return }
  if (-not $saved -or -not $saved.Pid) { return }
  $proc = Get-Process -Id $saved.Pid -ErrorAction SilentlyContinue
  $h = Get-Health
  if ($proc -and $h -and $h.instanceNonce -eq $saved.Nonce -and ([math]::Abs(($proc.StartTime - [datetime]::Parse($saved.StartTime)).TotalSeconds) -le 2)) {
    $script:Owned = @{ Pid = [int]$saved.Pid; StartTime = $saved.StartTime; Nonce = $saved.Nonce }
    Log ("找回登记：服务 PID {0} 仍是我拉起的那代（nonce 对上）" -f $saved.Pid) 'Green'
  } else {
    Log '登记文件对不上现状（服务换代或已死），作废旧登记' 'Yellow'
    Remove-Item $OwnedFile -Force
  }
}
function Claim-Service($nonce) {
  # 端口上的真 PID + 创建时间 + 健康端点回显 nonce，三件套齐了才算认领
  $svcPid = Get-ServicePid
  if (-not $svcPid) { return $false }
  $h = Get-Health
  if (-not $h -or $h.instanceNonce -ne $nonce) { return $false }
  $proc = Get-Process -Id $svcPid -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  $script:Owned = @{ Pid = [int]$svcPid; StartTime = $proc.StartTime.ToString('o'); Nonce = $nonce }
  Save-Owned
  return $true
}

# ---------- 拉起与杀 ----------
function Launch-Service($nonce, $requestId) {
  Log ("拉起服务（nonce {0}…）" -f $nonce.Substring(0, 8)) 'Cyan'
  $env:INSTANCE_NONCE = $nonce
  if ($requestId) { $env:RESTART_REQUEST_ID = $requestId } else { $env:RESTART_REQUEST_ID = $null }
  Start-Process cmd.exe -ArgumentList '/c', 'start.bat' -WorkingDirectory $HomeDir
  $env:INSTANCE_NONCE = $null
  $env:RESTART_REQUEST_ID = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (Claim-Service $nonce) {
      Log ("拉起成功并认领：服务 PID {0}，泽刷新页面即可重连" -f $script:Owned.Pid) 'Green'
      Beep-Ok
      return $true
    }
  }
  Log '!! 拉起失败：60 秒没等到健康端点回显我的 nonce，去看服务窗口报错' 'Red'
  return $false
}
function Kill-ServiceTree($targetPid, $expectStartIso) {
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if (-not $proc) { Log ("目标 PID {0} 已不在，无需动刀" -f $targetPid); return $true }
  if ($expectStartIso) {
    $expect = [datetime]::Parse($expectStartIso)
    if ([math]::Abs(($proc.StartTime - $expect).TotalSeconds) -gt 2) {
      Log ("!! PID {0} 创建时间与登记不符（PID 复用？），拒杀并报警" -f $targetPid) 'Red'
      Beep-Manual
      return $false
    }
  }
  if ((Get-AncestorPids) -contains [int]$targetPid) {
    Log ("!! PID {0} 在我自己的祖先链里，拒杀" -f $targetPid) 'Red'
    Beep-Manual
    return $false
  }
  Log ("杀服务进程树：PID {0}（Runner 与 Job 不在此树，动不到）" -f $targetPid) 'Yellow'
  taskkill /PID $targetPid /T /F | Out-Null
  for ($i = 0; $i -lt 15; $i++) { if (-not (Get-ServicePid)) { break }; Start-Sleep -Seconds 1 }
  return $true
}

# ---------- 重启流程（drain 拿锁 → 续租等待 → 杀 → 拉 → 认领） ----------
function Update-Phase($state, $phase) {
  $state.phase = $phase
  Write-AtomicJson $ProcFile $state
}
function Invoke-RestartFlow($state, $graceSeconds) {
  # state: @{ requestId; oldNonce; targetNonce; phase; requestedAt }
  $grace = 120
  if ($graceSeconds -and $graceSeconds -ge 10) { $grace = [math]::Min([int]$graceSeconds, 300) }
  $deadline = (Get-Date).AddSeconds($grace)
  $lastDrainAt = (Get-Date).AddDays(-1)
  Log ("重启单 {0}：开始 drain（宽限 {1} 秒，租约 60 秒每 20 秒一续）" -f $state.requestId, $grace) 'Cyan'
  Update-Phase $state 'waiting_drain'
  while ((Get-Date) -lt $deadline) {
    if (((Get-Date) - $lastDrainAt).TotalSeconds -ge 20) {
      $r = Send-Drain $state.requestId $state.oldNonce 60
      if ($r) { $lastDrainAt = Get-Date }
      else { Log 'drain 请求没成功（服务忙或已死），5 秒后重试' 'Yellow' }
    }
    $h = Get-Health
    if (-not $h) {
      if (-not (Get-ServicePid)) { Log '等待期间服务自己死了，直接进入拉起' 'Yellow'; break }
    } elseif ($h.restartReady -and $h.drainRequestId -eq $state.requestId) {
      Log 'restartReady=true 且锁是本单的，动刀' 'Green'
      break
    }
    Start-Sleep -Seconds 5
  }
  if ((Get-Date) -ge $deadline) { Log ("宽限 {0} 秒用尽，按设计单强制动手" -f $grace) 'Yellow' }
  Update-Phase $state 'killing'
  $expectStart = $null
  if ($script:Owned) { $expectStart = $script:Owned.StartTime }
  $killed = Kill-ServiceTree $script:Owned.Pid $expectStart
  if (-not $killed) { return $false }
  Update-Phase $state 'starting'
  $script:Owned = $null
  Save-Owned
  return (Launch-Service $state.targetNonce $state.requestId)
}
function Process-RestartRequest {
  if (-not (Test-Path $ReqFile)) { return }
  try { Move-Item -Path $ReqFile -Destination $ProcFile -ErrorAction Stop } catch { return }  # 抢占失败=别人在办/半截写入，下轮再看
  $req = $null
  try { $req = Get-Content $ProcFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $req = $null }  # 明示 UTF8：写单方（Node/Claude）都是无 BOM UTF-8，默认解码会把中文读成乱码
  if (-not $req -or -not $req.requestId -or -not $req.requestedAt) {
    Log '重启单格式坏，标记 .rejected' 'Red'
    Move-Item -Path $ProcFile -Destination (Join-Path $HomeDir ("restart.request.rejected.{0}" -f (Get-Date -Format 'HHmmss'))) -Force
    return
  }
  $age = ((Get-Date) - [datetime]::Parse($req.requestedAt)).TotalMinutes
  if ($age -gt 10) {
    Log ("重启单 {0} 已过期（{1:N0} 分钟前），标记 .rejected 不执行" -f $req.requestId, $age) 'Yellow'
    Move-Item -Path $ProcFile -Destination (Join-Path $HomeDir ("restart.request.rejected.{0}" -f (Get-Date -Format 'HHmmss'))) -Force
    return
  }
  if (-not $script:Owned) {
    Log '!! 收到重启单，但当前服务不是我拉起的（无 nonce 认领）——无权动刀，响铃转泽人工' 'Red'
    Beep-Manual
    Move-Item -Path $ProcFile -Destination (Join-Path $HomeDir ("restart.request.rejected.{0}" -f (Get-Date -Format 'HHmmss'))) -Force
    return
  }
  $state = @{ requestId = $req.requestId; oldNonce = $script:Owned.Nonce; targetNonce = (New-Nonce); phase = 'accepted'; requestedAt = $req.requestedAt }
  if ($req.reason) { Log ("重启单 {0}：{1}" -f $req.requestId, $req.reason) 'Cyan' }
  if (Invoke-RestartFlow $state $req.graceSeconds) {
    Remove-Item $ProcFile -Force
    Log ("重启单 {0} 办结" -f $req.requestId) 'Green'
  } else {
    Log ("!! 重启单 {0} 没办成，.processing 留着（我重启后会按 nonce 续办）" -f $req.requestId) 'Red'
  }
}
function Recover-Processing {
  if (-not (Test-Path $ProcFile)) { return }
  $st = $null
  try { $st = Get-Content $ProcFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $st = $null }
  if (-not $st -or -not $st.targetNonce) {
    Move-Item -Path $ProcFile -Destination (Join-Path $HomeDir 'restart.request.rejected.recover') -Force
    return
  }
  $age = ((Get-Date) - [datetime]::Parse($st.requestedAt)).TotalMinutes
  if ($age -gt 10) {
    Log ("遗留 .processing（单 {0}）已过期，作废" -f $st.requestId) 'Yellow'
    Move-Item -Path $ProcFile -Destination (Join-Path $HomeDir 'restart.request.rejected.recover') -Force
    return
  }
  $h = Get-Health
  if ($h) {
    if ($h.instanceNonce -eq $st.targetNonce) {
      Log ("遗留单 {0}：新代已在跑（nonce 对上 target），这单其实办完了，收编+销单" -f $st.requestId) 'Green'
      Claim-Service $st.targetNonce | Out-Null
      Remove-Item $ProcFile -Force
    } elseif ($h.instanceNonce -eq $st.oldNonce) {
      Log ("遗留单 {0}：还是旧代在跑，续办" -f $st.requestId) 'Cyan'
      if (Claim-Service $st.oldNonce) {
        if (Invoke-RestartFlow $st $null) { Remove-Item $ProcFile -Force }
      }
    } else {
      Log ("遗留单 {0}：服务 nonce 两头都对不上（泽手动换过代？），这单作废" -f $st.requestId) 'Yellow'
      Move-Item -Path $ProcFile -Destination (Join-Path $HomeDir 'restart.request.rejected.recover') -Force
    }
  } else {
    Log ("遗留单 {0}：服务死着，直接按 target nonce 拉新代" -f $st.requestId) 'Cyan'
    if (Launch-Service $st.targetNonce $st.requestId) { Remove-Item $ProcFile -Force }
  }
}

# ---------- 启动 ----------
Log ("Supervisor 上岗：盯 {0}，每 {1} 秒一查（日志 {2}）" -f $BaseUrl, $IntervalSec, $LogFile) 'Cyan'
Restore-Owned
Recover-Processing
if (-not (Get-ServicePid)) {
  Log '开机没见服务，直接拉一个' 'Cyan'
  Launch-Service (New-Nonce) $null | Out-Null
} elseif (-not $script:Owned) {
  $h = Get-Health
  if ($h -and $h.instanceNonce) {
    Log ("服务在跑但 nonce（{0}…）不是我登记的——只监控；要重启请泽手动" -f ([string]$h.instanceNonce).Substring(0, 8)) 'Yellow'
  } else {
    Log '服务在跑（手动 start.bat 起的，无 nonce）——只监控不认领；死了我再接手拉起' 'Yellow'
  }
}

# ---------- 主循环 ----------
$script:FailStreak = 0      # 健康检查连败（判死用）
$script:LaunchFails = 0     # 拉起连败（退避+封顶用）
$script:LastLaunchOkAt = $null
$script:ManualMode = $false
$backoff = @(5, 15, 60)

while ($true) {
  $svcPid = Get-ServicePid
  $h = $null
  if ($svcPid) { $h = Get-Health }

  if ($svcPid -and $h) {
    $script:FailStreak = 0
    # 换代侦测：端口上的 PID 跟登记不一致（泽手动重启了）→ 旧登记作废
    if ($script:Owned -and $svcPid -ne $script:Owned.Pid) {
      if ($h.instanceNonce -eq $script:Owned.Nonce) {
        # 罕见：PID 变了 nonce 没变（不该发生），保守作废
        Log '服务 PID 变了但 nonce 未变，异常，作废登记只监控' 'Yellow'
      } else {
        Log ("服务换代了（PID {0} → {1}），新代不是我拉的，转只监控" -f $script:Owned.Pid, $svcPid) 'Yellow'
      }
      $script:Owned = $null
      Save-Owned
    }
    if ($script:ManualMode) {
      Log '服务活了（泽手动拉起？），解除人工模式，恢复自动守护' 'Green'
      $script:ManualMode = $false
      $script:LaunchFails = 0
    }
    if ($script:LaunchFails -gt 0 -and $script:LastLaunchOkAt -and ((Get-Date) - $script:LastLaunchOkAt).TotalMinutes -ge 5) {
      $script:LaunchFails = 0
      Log '稳定运行满 5 分钟，退避计数清零' 'Green'
    }
    Process-RestartRequest
    if ($h.legacy) {
      Write-Host ("`r[{0}] 心跳 · PID {1}（旧代代码：HTTP 活着但无健康端点，重启后才升级）   " -f (Get-Date -Format 'HH:mm:ss'), $svcPid) -NoNewline -ForegroundColor DarkGray
    } else {
      $ownTag = '未认领'
      if ($script:Owned) { $ownTag = '已认领' }
      $drainTag = ''
      if ($h.draining) { $drainTag = " · draining({0})" -f $h.drainRequestId }
      Write-Host ("`r[{0}] 心跳 · PID {1}({2}) · 活跃轮 {3} · WS {4}{5}   " -f (Get-Date -Format 'HH:mm:ss'), $svcPid, $ownTag, $h.activeTurns, $h.wsClients, $drainTag) -NoNewline -ForegroundColor DarkGray
    }
  } elseif ($svcPid -and -not $h) {
    $script:FailStreak++
    Write-Host ("`r[{0}] 端口在、健康端点 {1}/3 次没应（僵死侦测中）   " -f (Get-Date -Format 'HH:mm:ss'), $script:FailStreak) -NoNewline -ForegroundColor Yellow
    if ($script:FailStreak -ge 3) {
      Log ("!! 端口活着但健康端点连续 {0} 次不响应——事件循环冻结" -f $script:FailStreak) 'Red'
      Beep-Alarm
      if ($script:Owned -and $svcPid -eq $script:Owned.Pid) {
        Log '僵死的是我登记的服务，杀树重拉' 'Yellow'
        if (Kill-ServiceTree $script:Owned.Pid $script:Owned.StartTime) {
          $script:Owned = $null; Save-Owned
          if (-not (Launch-Service (New-Nonce) $null)) { $script:LaunchFails++ }
        }
      } else {
        Log '僵死的服务不是我登记的，无权杀——响铃转泽人工' 'Red'
        Beep-Manual
        Start-Sleep -Seconds 30
      }
      $script:FailStreak = 0
    }
  } else {
    # 端口消失
    $script:FailStreak++
    if ($script:FailStreak -ge 3) {
      Log ("!! 服务死了（端口 {0} 连续 {1} 次无监听）" -f $Port, $script:FailStreak) 'Red'
      Beep-Alarm
      if ($script:ManualMode) {
        Write-Host ("`r[{0}] 人工模式：不自动拉，等泽处理   " -f (Get-Date -Format 'HH:mm:ss')) -NoNewline -ForegroundColor Red
      } else {
        # 给手动换代让 10 秒路，别抢跑
        $back = $false
        for ($i = 0; $i -lt 5; $i++) { Start-Sleep -Seconds 2; if (Get-ServicePid) { $back = $true; break } }
        if ($back) {
          Log '服务自己回来了（泽手动或自愈），继续监控' 'Green'
        } else {
          if ($script:LaunchFails -ge 10) {
            $script:ManualMode = $true
            Log '!! 连续拉起失败达 10 次，停止自动拉起转人工——去看服务窗口报错，修好后手动 start.bat' 'Red'
            Beep-Manual
          } else {
            $wait = $backoff[[math]::Min($script:LaunchFails, $backoff.Count - 1)]
            if ($script:LaunchFails -gt 0) {
              Log ("退避 {0} 秒后第 {1} 次重试拉起" -f $wait, ($script:LaunchFails + 1)) 'Yellow'
              Start-Sleep -Seconds $wait
            }
            $script:Owned = $null
            Save-Owned
            if (Launch-Service (New-Nonce) $null) {
              $script:LaunchFails = 0
              $script:LastLaunchOkAt = Get-Date
            } else {
              $script:LaunchFails++
            }
          }
        }
      }
      $script:FailStreak = 0
    } else {
      Write-Host ("`r[{0}] 端口没监听 {1}/3（确认中）   " -f (Get-Date -Format 'HH:mm:ss'), $script:FailStreak) -NoNewline -ForegroundColor Yellow
    }
  }
  Start-Sleep -Seconds $IntervalSec
}
