# Development Flight Recorder - one-time installer. Run elevated (it asks for the Windows "allow changes" prompt once).
# What it does:
#  1. Registers ONE scheduled task "DevFlightRecorder" that starts at Windows boot, runs as the current user
#     without a stored password (S4U), runs whether or not anyone is signed in, and restarts on failure.
#  2. Turns on Tailscale "run unattended" so the private network stays up when you are signed out.
# It changes nothing in your projects, agent histories or hooks.
param([string]$User = "$env:USERDOMAIN\$env:USERNAME")
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = (Get-Command node.exe).Source
$Log = Join-Path $Root 'install.log'
function Say($m) { $line = "$(Get-Date -Format o) $m"; Add-Content -Path $Log -Value $line; Write-Host $line }

Say "installing for $User using $Node"
$action = New-ScheduledTaskAction -Execute $Node -Argument "--disable-warning=ExperimentalWarning `"$Root\app\supervisor.js`"" -WorkingDirectory "$Root\app"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'DevFlightRecorder' -Description "Passive read-only development flight recorder ($Root)" `
  -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Say 'scheduled task registered (at startup, S4U, restart on failure)'

# Let the owning user start/stop/query this one task without elevation (adds read+execute for that user to the task's ACL).
$svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()
$folder = $svc.GetFolder('\'); $task = $folder.GetTask('DevFlightRecorder')
$sid = (New-Object System.Security.Principal.NTAccount($User)).Translate([System.Security.Principal.SecurityIdentifier]).Value
$sd = $task.GetSecurityDescriptor(4)
if ($sd -notmatch [regex]::Escape($sid)) { $task.SetSecurityDescriptor($sd + "(A;;GRGX;;;$sid)", 0); Say "granted $User run/stop rights on the task" }

$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path $ts) {
  & $ts set --unattended=true 2>&1 | ForEach-Object { Say "tailscale: $_" }
  Say 'tailscale unattended mode requested'
} else { Say 'tailscale not found; skipped' }

Start-ScheduledTask -TaskName 'DevFlightRecorder'
Say 'task started'
