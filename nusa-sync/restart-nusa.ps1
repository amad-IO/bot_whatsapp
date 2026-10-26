param([ValidateSet('Stop','Start')][string]$Mode)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Nusa\nusa.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Nusa tidak ditemukan.' }
$running = Get-Process -Name nusa -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }
if ($Mode -eq 'Stop') {
  foreach ($process in $running) { Stop-Process -Id $process.Id -ErrorAction Stop }
  if ($running) { Write-Output 'running' }
} elseif (!$running) { Start-Process -FilePath $exe -WindowStyle Normal }
