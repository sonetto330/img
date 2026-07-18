# 家服务守护窗口（watchdog）
# 用法：泽右键此文件 →"使用 PowerShell 运行"，让窗口一直开着（可以最小化，别关）。
# 它干三件事：
#   1. 每 5 秒看一眼端口 3000 的服务活没活，活着就在同一行刷心跳（不刷屏）
#   2. 服务死了 → 红字报警 + 响铃；先等 20 秒（可能是重启器正在换代，别跟它抢），
#      还没活 → 自动用 start.bat 拉起，最多等 60 秒确认端口回来
#   3. 所有生死事件写进 watchdog.log，泽不在电脑前也有账可查
# 关键：这个窗口不在服务进程树里，服务和麦穗怎么死，它都死不了。
param([int]$Port = 3000, [int]$IntervalSec = 5)
$ErrorActionPreference = 'SilentlyContinue'
$logPath = Join-Path $PSScriptRoot 'watchdog.log'
$host.UI.RawUI.WindowTitle = "家·守护窗口（别关我）"

function Log($msg, $color) {
  if (-not $color) { $color = 'Gray' }
  $line = "[{0}] {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $msg
  Write-Host ""
  Write-Host $line -ForegroundColor $color
  Add-Content -Path $logPath -Value $line -Encoding UTF8
}

function Get-ServicePid {
  $conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($conn) { return ($conn | Select-Object -First 1).OwningProcess }
  return $null
}

Log ("守护窗口上岗：盯端口 {0}，每 {1} 秒一查" -f $Port, $IntervalSec) 'Cyan'
$lastPid = $null

while ($true) {
  $svcPid = Get-ServicePid
  if ($svcPid) {
    if ($svcPid -ne $lastPid) {
      if ($lastPid) { Log ("服务换代了：PID {0} → {1}" -f $lastPid, $svcPid) 'Yellow' }
      else { Log ("服务在跑：PID {0}" -f $svcPid) 'Green' }
      $lastPid = $svcPid
    }
    $claudeCount = (Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Measure-Object).Count
    Write-Host ("`r[{0}] 心跳正常 · 服务 PID {1} · 麦穗(claude.exe) {2} 个   " -f (Get-Date -Format 'HH:mm:ss'), $svcPid, $claudeCount) -NoNewline -ForegroundColor DarkGray
  } else {
    Log ("!! 服务死了（端口 {0} 没人监听）" -f $Port) 'Red'
    [console]::beep(880, 500)
    # 先等 20 秒：可能是 restart-home.ps1 正在换代，别双重拉起打架
    $recovered = $false
    for ($i = 0; $i -lt 10; $i++) {
      Start-Sleep -Seconds 2
      $svcPid = Get-ServicePid
      if ($svcPid) { $recovered = $true; break }
    }
    if ($recovered) {
      Log ("服务自己回来了（应该是重启器换代），新 PID {0}" -f $svcPid) 'Green'
      $lastPid = $svcPid
    } else {
      Log "20 秒没恢复，守护窗口自己拉起 start.bat" 'Yellow'
      Start-Process cmd.exe -ArgumentList '/c', 'start.bat' -WorkingDirectory $PSScriptRoot
      $ok = $false
      for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        $svcPid = Get-ServicePid
        if ($svcPid) { $ok = $true; break }
      }
      if ($ok) {
        Log ("拉起成功：服务 PID {0}，泽刷新页面即可重连" -f $svcPid) 'Green'
        $lastPid = $svcPid
        [console]::beep(1320, 300)
      } else {
        Log "!! 拉起失败：60 秒没见端口，去看新开的服务窗口里的报错" 'Red'
        $lastPid = $null
        Start-Sleep -Seconds 30
      }
    }
  }
  Start-Sleep -Seconds $IntervalSec
}
