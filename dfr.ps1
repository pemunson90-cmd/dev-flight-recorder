# Development Flight Recorder - the one control.
#   powershell -File dfr.ps1 status      show whether it is running and healthy, and the phone link
#   powershell -File dfr.ps1 stop        stop recording (until next boot or "start")
#   powershell -File dfr.ps1 start       start recording now
#   powershell -File dfr.ps1 uninstall   remove the startup task and phone link; MOVES (never deletes) the program
#                                        and its data into a _scrap folder per the no-delete rule. Needs elevation.
param([Parameter(Mandatory)][ValidateSet('status','stop','start','uninstall')][string]$Cmd)
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
switch ($Cmd) {
  'status' {
    $t = Get-ScheduledTask -TaskName 'DevFlightRecorder' -ErrorAction SilentlyContinue
    if (-not $t) { 'Startup task: NOT installed' } else { "Startup task: $($t.State)" }
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:$($cfg.local_admin.port)/api/health" -TimeoutSec 5
      "Recorder: $($h.state) (running since $($h.started_utc), pid $($h.pid), as $($h.run_as))"
      if ($h.problems) { $h.problems | ForEach-Object { "  problem: $_" } }
      "Data: $($h.storage.data_dir)"
    } catch { 'Recorder: not answering on the local port' }
    if (Test-Path $ts) { $s = & $ts serve status 2>&1 | Out-String; "Phone link (Tailscale Serve):`n$s" }
  }
  'stop'  {
    Stop-ScheduledTask -TaskName 'DevFlightRecorder'
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'DevFlightRecorder\\app\\(supervisor|recorder)\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    # The recorder can take a few seconds to close; wait, then end whatever still holds its own loopback ports.
    $ports = @($cfg.local_admin.port, $cfg.remote_report.port)
    for ($i = 0; $i -lt 15; $i++) {
      $held = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $ports -State Listen -ErrorAction SilentlyContinue
      if (-not $held) { break }
      Start-Sleep -Seconds 1
    }
    if ($held) { $held | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }
    'Stopped.'
  }
  'start' { Start-ScheduledTask -TaskName 'DevFlightRecorder'; 'Started.' }
  'uninstall' {
    if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrator')) {
      Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" uninstall"; return
    }
    & $PSCommandPath stop
    Unregister-ScheduledTask -TaskName 'DevFlightRecorder' -Confirm:$false -ErrorAction SilentlyContinue
    if (Test-Path $ts) { & $ts serve --https=443 off 2>&1 | Out-Null }   # removes only this phone link; Tailscale itself stays
    $stamp = Get-Date -Format 'yyyyMMdd'
    $scrap = Join-Path ([Environment]::GetFolderPath('MyDocuments')) "_to_delete\DevFlightRecorder-uninstalled-$stamp"
    New-Item -ItemType Directory -Force $scrap | Out-Null
    Move-Item -Path $cfg.data_dir -Destination (Join-Path $scrap 'data') -ErrorAction SilentlyContinue
    Move-Item -Path $Root -Destination (Join-Path $scrap 'program') -ErrorAction SilentlyContinue
    "Uninstalled. Program and data moved (not deleted) to $scrap"
  }
}
