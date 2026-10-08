# Cai may chu tep NOIBO chay ngam, tu bat khi khoi dong may, tu chay lai khi bi tat.
# Chay bang PowerShell "Run as Administrator" trong thu muc fileserver:
#   powershell -ExecutionPolicy Bypass -File .\install-task.ps1
# Go bo:  Unregister-ScheduledTask -TaskName "NOIBO-FileServer" -Confirm:$false

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
if (-not (Test-Path "$dir\.env")) { throw "Chua co file .env - chep .env.example thanh .env roi sua truoc." }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Chua cai Node.js (https://nodejs.org - ban LTS), cai xong mo lai PowerShell." }

$action   = New-ScheduledTaskAction -Execute "$dir\start.cmd" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "NOIBO-FileServer" -Action $action -Trigger $trigger -Settings $settings `
  -User "SYSTEM" -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName "NOIBO-FileServer"
Start-Sleep -Seconds 3
Write-Host "Da cai va chay NOIBO-FileServer. Xem log: $dir\logs\server.log"
Get-Content "$dir\logs\server.log" -Tail 5 -ErrorAction SilentlyContinue
