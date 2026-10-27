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
foreach ($name in @('connector.js','core.js','read-key.ps1','restart-nusa.ps1','start.ps1','guard.vbs')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $target -Force }
@{server=$uri.GetLeftPart([UriPartial]::Authority)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'config.json') -Encoding UTF8
ConvertTo-SecureString -String $key -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $target 'key.dpapi')
$key = $null
$nodePath = (Get-Command node.exe).Source
@{node=$nodePath} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'runtime.json') -Encoding UTF8
$oldTask = Get-ScheduledTask -TaskName 'Nusa TodoList Sync' -ErrorAction SilentlyContinue
if ($oldTask) { Stop-ScheduledTask -TaskName 'Nusa TodoList Sync'; Unregister-ScheduledTask -TaskName 'Nusa TodoList Sync' -Confirm:$false }
$startup = [Environment]::GetFolderPath('Startup')
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $startup 'Nusa TodoList Sync.lnk'))
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = '"' + (Join-Path $target 'guard.vbs') + '"'
$shortcut.WindowStyle = 7
$shortcut.Description = 'Sinkronisasi TodoList Nusa dengan pemulihan otomatis'
$shortcut.Save()
$guard = Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" | Where-Object { $_.CommandLine -like '*NusaSync*guard.vbs*' }
if (!$guard) { Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WindowStyle Hidden }
Write-Host 'NusaSync terpasang untuk pengguna ini.'
