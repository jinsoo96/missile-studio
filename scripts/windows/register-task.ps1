# Register missile-studio as a Windows scheduled task that starts at boot without a login
# (S4U principal), so the web UI survives reboots on an always-on PC.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\register-task.ps1 -MissileExe "C:\path\to\missile.exe" -Port 7700
# Remove:  Unregister-ScheduledTask -TaskName MISSILE-STUDIO-serve -Confirm:$false
param(
  [string]$TaskName = "MISSILE-STUDIO-serve",
  [string]$MissileExe = "missile",
  [string]$MissileHome = "$env:USERPROFILE\.missile-studio",
  [string]$BindHost = "127.0.0.1",
  [int]$Port = 7700,
  [string]$User = $env:USERNAME
)
$ErrorActionPreference = "Stop"
$cmd = Join-Path $PSScriptRoot "missile-serve.cmd"
if (-not (Test-Path $cmd)) { throw "missing $cmd" }
$envBlock = "set MISSILE_EXE=$MissileExe&& set MISSILE_HOME=$MissileHome&& set MISSILE_HOST=$BindHost&& set MISSILE_PORT=$Port&& "
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $envBlock call `"$cmd`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) { Write-Host "ok: $TaskName registered and listening on ${BindHost}:$Port (log: $MissileHome\logs\serve.log)" }
else { Write-Host "registered $TaskName but nothing listens on $Port yet; check $MissileHome\logs\serve.log" }
