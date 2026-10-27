$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = New-Object System.Threading.Mutex($false, ('Local\NusaSyncGuard-' + $sid))
$ownsMutex = $false
try {
  try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (!$ownsMutex) { exit 0 }
  $powershell = Join-Path $PSHOME 'powershell.exe'
  $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'start.ps1') + '"'
  while ($true) {
    try {
      $child = Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
      if ($child.ExitCode -ne 0) { throw 'Penghubung berhenti.' }
    } catch {
      Add-Content -LiteralPath (Join-Path $PSScriptRoot 'guard.log') -Value ((Get-Date).ToString('o') + ' Penghubung berhenti; mencoba menjalankan kembali.') -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 5
  }
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
