$ErrorActionPreference = 'Stop'
$runtime = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Raw | ConvertFrom-Json
$nodePath = $runtime.node
if (!(Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'Node.js tidak ditemukan.' }
& $nodePath (Join-Path $PSScriptRoot 'connector.js')
exit $LASTEXITCODE
