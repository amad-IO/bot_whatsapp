$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = New-Object System.Threading.Mutex($false, ('Local\NusaSync-' + $sid))
$ownsMutex = $false
try {
  try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (!$ownsMutex) { exit 0 }
  $worker = Join-Path $PSScriptRoot 'connector.js'
  $running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like ('*' + $worker + '*') }
  if ($running) { exit 0 }
  $runtime = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw | ConvertFrom-Json
  $nodePath = $runtime.node
  if (!(Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'Node.js tidak ditemukan.' }
  & $nodePath $worker *> (Join-Path $PSScriptRoot 'task.log')
  exit $LASTEXITCODE
} catch {
  Add-Content -LiteralPath (Join-Path $PSScriptRoot 'task.log') -Value ((Get-Date).ToString('o') + ' Peluncur gagal: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
