$ErrorActionPreference = 'Stop'
$Setup = Join-Path $PSScriptRoot 'setup-assets.py'
if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $Setup
} else {
    & python $Setup
}
exit $LASTEXITCODE
