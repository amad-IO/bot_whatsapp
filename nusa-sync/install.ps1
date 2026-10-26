param([Parameter(Mandatory=$true)][string]$Server, [Parameter(Mandatory=$true)][string]$KeyFile)
$ErrorActionPreference = 'Stop'
$uri = [Uri]$Server
if ($uri.Scheme -ne 'https' -or $uri.AbsolutePath -ne '/') { throw 'Server harus HTTPS tanpa path.' }
$key = (Get-Content -LiteralPath $KeyFile -Raw).Trim()
if ($key -notmatch '^[a-f0-9]{64}$') { throw 'Kunci tidak valid.' }
$target = Join-Path $env:LOCALAPPDATA 'NusaSync'
New-Item -ItemType Directory -Force -Path $target | Out-Null
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $target '/inheritance:r' '/grant:r' "${account}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Tidak dapat mengamankan folder NusaSync.' }
foreach ($name in @('connector.js','core.js','read-key.ps1','restart-nusa.ps1','start.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $target -Force }
@{server=$uri.GetLeftPart([UriPartial]::Authority)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'config.json') -Encoding UTF8
ConvertTo-SecureString -String $key -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $target 'key.dpapi')
$key = $null
$nodePath = (Get-Command node.exe).Source
@{node=$nodePath} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'runtime.json') -Encoding UTF8
$startCommand = "`$env:PSModulePath=Join-Path `$PSHOME 'Modules'; & '" + $nodePath.Replace("'", "''") + "' '" + (Join-Path $target 'connector.js').Replace("'", "''") + "' *> '" + (Join-Path $target 'task.log').Replace("'", "''") + "'; exit `$LASTEXITCODE"
$action = New-ScheduledTaskAction -Execute (Get-Command powershell.exe).Source -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $startCommand + '"')
$oldTask = Get-ScheduledTask -TaskName 'Nusa TodoList Sync' -ErrorAction SilentlyContinue
if ($oldTask) { Stop-ScheduledTask -TaskName 'Nusa TodoList Sync'; Disable-ScheduledTask -TaskName 'Nusa TodoList Sync' | Out-Null }
# A per-user Startup shortcut runs in the same interactive profile as Nusa.
$startup = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $startup 'Nusa TodoList Sync.lnk'))
$shortcut.TargetPath = $action.Execute
$shortcut.Arguments = $action.Arguments
$shortcut.WorkingDirectory = $target
$shortcut.WindowStyle = 7
$shortcut.Description = 'Sinkronisasi TodoList WA dan Nusa'
$shortcut.Save()
$running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*NusaSync*connector.js*' }
if (!$running) { Start-Process -FilePath $action.Execute -ArgumentList $action.Arguments -WorkingDirectory $target -WindowStyle Hidden }
Write-Host 'NusaSync terpasang untuk pengguna ini.'
