# 以「系統管理員」身分在 PowerShell 執行一次：
#   powershell -ExecutionPolicy Bypass -File D:\cangwang\ai-studio\windows-autostart.ps1
# 作用：登入 Windows 後自動在背景喚醒 WSL 並保持常駐（ollama + ai-studio 服務跟著起來），
#       並把插電時的睡眠關掉，避免半夜睡著。
param([string]$Distro = "Ubuntu", [int]$PowerLimit = 115)

$list = (wsl.exe -l -q) -replace "`0", "" | Where-Object { $_.Trim() -ne "" }
if ($list -notcontains $Distro) {
    Write-Host "找不到發行版 $Distro。現有：" ($list -join ", ")
    Write-Host "請改用：-Distro <名稱>"
    exit 1
}

$action  = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless wsl.exe -d $Distro --exec sleep infinity"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
           -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "ai-studio-wsl-keepalive" -Action $action -Trigger $trigger `
    -Settings $set -Description "Keep WSL alive for Ollama + ai-studio" -Force | Out-Null
Write-Host "已建立開機自啟排程：ai-studio-wsl-keepalive"

# 顯卡功耗上限（開機時以 SYSTEM 身分套用，重開機也會保留）
$smi = (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue).Source
if (-not $smi) { $smi = "C:\Windows\System32\nvidia-smi.exe" }
$pa = New-ScheduledTaskAction -Execute $smi -Argument "-pl $PowerLimit"
$pt = New-ScheduledTaskTrigger -AtStartup
$pp = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "ai-studio-gpu-powerlimit" -Action $pa -Trigger $pt -Principal $pp `
    -Description "RTX A4000 power limit $PowerLimit W" -Force | Out-Null
& $smi -pl $PowerLimit | Out-Null
Write-Host "已設定顯卡功耗上限 ${PowerLimit}W（每次開機自動套用）"

powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host "已關閉插電時的睡眠與休眠（螢幕關閉不受影響）"

Start-ScheduledTask -TaskName "ai-studio-wsl-keepalive"
Write-Host "已立即啟動一次。"
