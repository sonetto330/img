# 家服务安全重启器
# 用法：不要直接在麦穗的黑窗口里跑，也不要让麦穗前台调用——它必须脱离调用者进程树独立运行。
# 麦穗的做法（脱树启动，WMI 拉起的进程不在任何人的树里）：
#   Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell -ExecutionPolicy Bypass -File C:\Users\Lenovo\home\restart-home.ps1' }
# 泽的做法：右键"使用 PowerShell 运行"，等价于关黑窗口重开 start.bat，少一步找窗口。
param([int]$Port = 3000)
$ErrorActionPreference = 'SilentlyContinue'

Write-Host "[重启器] 3 秒后动手（给麦穗留出把最后一条消息送到前端的时间）..."
Start-Sleep -Seconds 3
$conn = Get-NetTCPConnection -State Listen -LocalPort $Port
if ($conn) {
  $oldPid = $conn.OwningProcess
  Write-Host "[重启器] 杀旧服务 PID=$oldPid"
  Stop-Process -Id $oldPid -Force
  Start-Sleep -Seconds 2
} else {
  Write-Host "[重启器] 端口 $Port 上没有在跑的服务，直接起新的"
}

Set-Location $PSScriptRoot
Write-Host "[重启器] 起新服务..."
Start-Process cmd.exe -ArgumentList '/c', 'start.bat'
Write-Host "[重启器] 完成。泽刷新页面即可重连。"
