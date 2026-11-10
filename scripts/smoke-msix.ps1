# Installs the MSIX made by scripts/build-msix.ps1, starts the app from it,
# checks that its embedded API and UI answer, then removes it again. Windows
# only installs signed packages, so a copy is signed with a throwaway
# certificate for the publisher in the manifest (the Store signs the real one).
# Needs an elevated shell (the certificate goes to the machine's TrustedPeople
# store), as on the GitHub runner.
param(
  [string]$Msix = (Get-ChildItem (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist/store') -Filter '*.msix' | Select-Object -First 1).FullName
)
$ErrorActionPreference = 'Stop'
if (-not $Msix -or -not (Test-Path $Msix)) { throw 'no MSIX found in dist/store' }
Write-Host "Testing $Msix"

# Identity and publisher as packed.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($Msix)
try {
  $reader = New-Object IO.StreamReader ($zip.GetEntry('AppxManifest.xml').Open())
  [xml]$manifest = $reader.ReadToEnd()
  $reader.Close()
} finally { $zip.Dispose() }
$name = $manifest.Package.Identity.Name
$publisher = $manifest.Package.Identity.Publisher
Write-Host "Package $name $($manifest.Package.Identity.Version), publisher $publisher"

$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*\x64" -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName 'signtool.exe') } |
  Sort-Object { [version]($_.Parent.Name) } | Select-Object -Last 1
$signtool = Join-Path $sdk.FullName 'signtool.exe'

$work = Join-Path ([IO.Path]::GetTempPath()) 'nats-explorer-msix-smoke'
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null
$signed = Join-Path $work 'signed.msix'
Copy-Item $Msix $signed

$cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -KeyUsage DigitalSignature `
  -FriendlyName 'NATS Explorer MSIX smoke test' -CertStoreLocation 'Cert:\CurrentUser\My' `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$pfx = Join-Path $work 'test.pfx'
$password = ConvertTo-SecureString -String 'smoke' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $password | Out-Null
$cer = Join-Path $work 'test.cer'
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
$app = $null
try {
  & $signtool sign /fd SHA256 /f $pfx /p smoke $signed | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }

  Add-AppxPackage -Path $signed
  $pkg = Get-AppxPackage -Name $name
  if (-not $pkg) { throw "$name not installed" }
  Write-Host "Installed $($pkg.PackageFullName) to $($pkg.InstallLocation)"

  # Started the way the Start menu does it, so it runs inside the package.
  Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!App"
  $port = $null
  for ($i = 0; $i -lt 60 -and -not $port; $i++) {
    Start-Sleep -Milliseconds 500
    $app = Get-Process -Name 'nats-explorer' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($app) {
      $conn = Get-NetTCPConnection -State Listen -OwningProcess $app.Id -ErrorAction SilentlyContinue |
        Where-Object LocalAddress -eq '127.0.0.1' | Select-Object -First 1
      if ($conn) { $port = $conn.LocalPort }
    }
  }
  if (-not $app) { throw 'the packaged app did not start' }
  if (-not $port) { throw 'the packaged app never opened its API port' }
  if ($app.Path -notlike "$($pkg.InstallLocation)*") { throw "running $($app.Path), not the packaged binary" }
  $auth = Invoke-RestMethod "http://127.0.0.1:$port/api/auth"
  if ($null -eq $auth.required) { throw 'unexpected /api/auth answer' }
  $html = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing
  if ($html.Content -notmatch 'id="root"') { throw 'UI not served' }
  # A packaged build has to know it is one: it leaves updates to the Store.
  $info = Invoke-RestMethod "http://127.0.0.1:$port/api/app"
  if ($info.distribution -ne 'msix') { throw "not reported as msix: $($info | ConvertTo-Json -Compress)" }
  $update = Invoke-RestMethod "http://127.0.0.1:$port/api/update"
  if ($update.supported) { throw "the packaged app offers to update itself: $($update | ConvertTo-Json -Compress)" }
  Write-Host "API on port $port, UI served, reports itself as msix, settings storage: $($info.storage)"
} finally {
  if ($app) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
  Get-AppxPackage -Name $name | Remove-AppxPackage -ErrorAction SilentlyContinue
  Get-ChildItem 'Cert:\LocalMachine\TrustedPeople' | Where-Object Thumbprint -eq $cert.Thumbprint | Remove-Item
  Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)"
}
if (Get-AppxPackage -Name $name) { throw 'package still installed after removal' }
Write-Host 'MSIX smoke test passed'
