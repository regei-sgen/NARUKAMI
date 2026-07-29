# One-time elevated setup: give NARUKAMI a real CPU die temperature.
#
# WHY THIS EXISTS
#   Windows exposes no first-party CPU-temperature API. Reading the Intel/AMD
#   MSR needs a kernel driver, so LibreHardwareMonitor ships one and its
#   manifest is `requireAdministrator`. NARUKAMI runs unelevated and therefore
#   cannot start LHM without a UAC prompt on every single launch.
#
#   This script registers a Scheduled Task with "run with highest privileges".
#   Task Scheduler bypasses UAC for such a task, so after this ONE consent
#   NARUKAMI can start LHM silently forever (see src/lhm.ts).
#
#   It also enables LHM's Remote Web Server on 127.0.0.1:8085 — the only path
#   NARUKAMI can read, because modern LHM ships no WMI provider. The backend
#   consumes it in services/pcstats.ts (`readLhmWeb`).
#
# USAGE (from an ELEVATED PowerShell):
#   powershell -ExecutionPolicy Bypass -File packages\desktop\scripts\setup-lhm.ps1
#
# Prerequisite: winget install --id LibreHardwareMonitor.LibreHardwareMonitor
#
# To undo:  Unregister-ScheduledTask -TaskName 'NARUKAMI LibreHardwareMonitor'
$ErrorActionPreference = 'Stop'
$TaskName = 'NARUKAMI LibreHardwareMonitor'
$Port = 8085

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
      ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'ERROR: run this from an elevated PowerShell (Run as Administrator).'
  exit 1
}

# Locate LibreHardwareMonitor: winget package dir first, then a classic install.
$dir = $null
$wingetPkgs = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
if (Test-Path $wingetPkgs) {
  $hit = Get-ChildItem $wingetPkgs -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'LibreHardwareMonitor' } | Select-Object -First 1
  if ($hit) { $dir = $hit.FullName }
}
if (-not $dir) {
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    $c = Join-Path $root 'LibreHardwareMonitor'
    if (Test-Path (Join-Path $c 'LibreHardwareMonitor.exe')) { $dir = $c; break }
  }
}
if (-not $dir) {
  Write-Output 'ERROR: LibreHardwareMonitor not found.'
  Write-Output '       winget install --id LibreHardwareMonitor.LibreHardwareMonitor'
  exit 1
}
$exe = Join-Path $dir 'LibreHardwareMonitor.exe'
if (-not (Test-Path $exe)) { Write-Output "ERROR: exe missing at $exe"; exit 1 }
Write-Output "exe: $exe"

# 1. Stop any running instance -- LHM rewrites its config on exit and would
#    clobber the settings we are about to write.
Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output "stopping running LHM pid $($_.Id)"
  Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

# 2. Write the config. These keys were verified by extracting the string
#    literals out of LibreHardwareMonitor.exe (0.9.6) -- they are the real
#    setting names, not guesses.
$cfg = Join-Path $dir 'LibreHardwareMonitor.config'
$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <appSettings>
    <add key="runWebServerMenuItem" value="true" />
    <add key="listenerPort" value="$Port" />
    <add key="startMinMenuItem" value="true" />
    <add key="minTrayMenuItem" value="true" />
    <add key="minCloseMenuItem" value="true" />
    <add key="celsiusMenuItem" value="true" />
  </appSettings>
</configuration>
"@
Set-Content -Path $cfg -Value $xml -Encoding UTF8
Write-Output "config written: $cfg"

# 3. Register the task: elevated, at logon, and runnable on demand by NARUKAMI.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Output 'removed previous task'
}
$me        = "$env:USERDOMAIN\$env:USERNAME"
$action    = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $dir
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $me
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings | Out-Null
Write-Output "task registered: $TaskName (user $me, highest privileges)"

# 4. Start it and prove the sensor feed actually answers.
Start-ScheduledTask -TaskName $TaskName
Write-Output 'task started; waiting for the web server...'
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/data.json" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) {
      Write-Output "WEB SERVER UP: HTTP 200, $($r.Content.Length) bytes"
      $ok = $true
      break
    }
  } catch { }
}
if (-not $ok) {
  Write-Output "WEB SERVER DID NOT COME UP on $Port"
  Write-Output 'Open LibreHardwareMonitor and check Options -> Remote Web Server.'
}
Write-Output 'SETUP-DONE'
