# Packs the Windows desktop build (go-server/build/bin/nats-explorer.exe, made by
# scripts/build-desktop.sh windows) into an MSIX for the Microsoft Store. The
# package stays unsigned: the Store signs it when the submission is certified.
#
#   scripts/build-msix.ps1 [-Version 1.2.3]
#
# Identity and publisher come from the environment (MSIX_IDENTITY_NAME,
# MSIX_PUBLISHER, MSIX_PUBLISHER_DISPLAY_NAME; Partner Center > Product
# identity). Without them the package gets placeholders: fine for testing,
# refused by the Store. Needs the Windows SDK (makeappx, makepri).
param(
  [string]$Version = $env:GITHUB_REF_NAME
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# MSIX wants four numeric parts and the Store a 0 in the fourth; branch builds
# (workflow_dispatch) have no version and get 0.0.0.
$numeric = if ($Version -match '^v?(\d+\.\d+\.\d+)') { $Matches[1] } else { '0.0.0' }
$msixVersion = "$numeric.0"
$fileVersion = if ($Version -match '^v?(\d+\.\d+\.\d+.*)$') { $Matches[1] } else { $numeric }

$identity = if ($env:MSIX_IDENTITY_NAME) { $env:MSIX_IDENTITY_NAME } else { 'blanpa.NATSExplorer' }
$publisher = if ($env:MSIX_PUBLISHER) { $env:MSIX_PUBLISHER } else { 'CN=blanpa' }
$publisherName = if ($env:MSIX_PUBLISHER_DISPLAY_NAME) { $env:MSIX_PUBLISHER_DISPLAY_NAME } else { 'blanpa' }

$exe = Join-Path $root 'go-server/build/bin/nats-explorer.exe'
if (-not (Test-Path $exe)) { throw "missing $($exe): run scripts/build-desktop.sh windows first" }

# The newest SDK that has the tools.
$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*\x64" -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'makeappx.exe') } |
  Sort-Object { [version]($_.Parent.Name) } | Select-Object -Last 1
if (-not $sdk) { throw 'Windows SDK with makeappx.exe not found' }
$makeappx = Join-Path $sdk.FullName 'makeappx.exe'
$makepri = Join-Path $sdk.FullName 'makepri.exe'
Write-Host "SDK tools from $($sdk.FullName)"

$work = Join-Path ([IO.Path]::GetTempPath()) 'nats-explorer-msix'
$layout = Join-Path $work 'layout'
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $layout | Out-Null
Copy-Item $exe $layout
Copy-Item -Recurse (Join-Path $root 'go-server/build/windows/msix/Assets') $layout

$manifest = Get-Content -Raw (Join-Path $root 'go-server/build/windows/msix/AppxManifest.xml')
$manifest = $manifest.Replace('@IDENTITY_NAME@', $identity).Replace('@PUBLISHER@', [Security.SecurityElement]::Escape($publisher)).
  Replace('@PUBLISHER_DISPLAY_NAME@', [Security.SecurityElement]::Escape($publisherName)).Replace('@VERSION@', $msixVersion)
Set-Content -Path (Join-Path $layout 'AppxManifest.xml') -Value $manifest -Encoding utf8

# resources.pri maps the scale- and targetsize-qualified logos to the names
# the manifest uses.
$priConfig = Join-Path $work 'priconfig.xml'
& $makepri createconfig /cf $priConfig /dq en-US /pv 10.0.0 /o | Out-Host
if ($LASTEXITCODE -ne 0) { throw "makepri createconfig failed ($LASTEXITCODE)" }
& $makepri new /pr $layout /cf $priConfig /of (Join-Path $layout 'resources.pri') /mn (Join-Path $layout 'AppxManifest.xml') /o | Out-Host
if ($LASTEXITCODE -ne 0) { throw "makepri new failed ($LASTEXITCODE)" }

$out = Join-Path $root 'dist/store'
New-Item -ItemType Directory -Force $out | Out-Null
$msix = Join-Path $out "nats-explorer-desktop-$fileVersion-windows-x64.msix"
& $makeappx pack /d $layout /p $msix /o | Out-Host
if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed ($LASTEXITCODE)" }
Write-Host "MSIX $msix (version $msixVersion, identity $identity, publisher $publisher)"
