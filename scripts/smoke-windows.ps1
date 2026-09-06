# Installs the NSIS setup silently, launches the installed app, checks that its
# embedded API answers, then uninstalls silently. Run on the Windows runner.
$ErrorActionPreference = 'Stop'
$setup = Get-ChildItem dist/desktop -Filter '*-setup.exe' | Select-Object -First 1
if (-not $setup) { throw 'no installer found in dist/desktop' }
$target = Join-Path $env:LOCALAPPDATA 'Programs\NATS Explorer'
Write-Host "Installing $($setup.FullName) to $target"
$p = Start-Process -FilePath $setup.FullName -ArgumentList "/S", "/D=$target" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "installer exit code $($p.ExitCode)" }
$exe = Join-Path $target 'nats-explorer.exe'
if (-not (Test-Path $exe)) { throw "installed binary missing at $exe" }
$uninst = Get-ChildItem $target -Filter 'uninstall*.exe' | Select-Object -First 1
if (-not $uninst) { throw 'uninstaller missing' }
Write-Host 'Launching installed app'
$app = Start-Process -FilePath $exe -PassThru
# The app writes nothing to stdout when started from PowerShell; find its API port via listening sockets.
$port = $null
for ($i = 0; $i -lt 60 -and -not $port; $i++) {
  Start-Sleep -Milliseconds 500
  if ($app.HasExited) { throw "app exited with code $($app.ExitCode)" }
  $conn = Get-NetTCPConnection -State Listen -OwningProcess $app.Id -ErrorAction SilentlyContinue | Where-Object LocalAddress -eq '127.0.0.1' | Select-Object -First 1
  if ($conn) { $port = $conn.LocalPort }
}
if (-not $port) { Stop-Process -Id $app.Id -Force; throw 'app never opened its API port' }
$auth = Invoke-RestMethod "http://127.0.0.1:$port/api/auth"
if ($null -eq $auth.required) { throw 'unexpected /api/auth answer' }
$html = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing
if ($html.Content -notmatch 'id="root"') { throw 'UI not served' }
Write-Host "API on port $port, UI served"
Stop-Process -Id $app.Id -Force
Write-Host 'Uninstalling'
$u = Start-Process -FilePath $uninst.FullName -ArgumentList '/S' -Wait -PassThru
if ($u.ExitCode -ne 0) { throw "uninstaller exit code $($u.ExitCode)" }
Start-Sleep -Seconds 2
if (Test-Path $exe) { throw 'binary still present after uninstall' }
Write-Host 'Windows smoke test passed'
