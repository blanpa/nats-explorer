#!/usr/bin/env bash
# Checks the store metadata against the changelog, so a release cannot ship
# with stale AppStream data: the newest released version in CHANGELOG.md has
# to be listed in the metainfo with the same date. Also validates the
# metainfo, the desktop entry and the MSIX manifest with the tools that are
# installed (appstreamcli, desktop-file-validate). Usage: scripts/check-packaging.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
METAINFO="$ROOT/go-server/build/linux/io.github.blanpa.nats-explorer.metainfo.xml"
exec python3 - "$ROOT" "$METAINFO" <<'PY'
import re, shutil, subprocess, sys
import xml.etree.ElementTree as ET

root, metainfo = sys.argv[1:3]
errors = []

changelog = open(f'{root}/CHANGELOG.md', encoding='utf-8').read()
released = re.findall(r'^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})', changelog, re.M)
if not released:
    errors.append('CHANGELOG.md: no released version found')
else:
    version, date = released[0]
    releases = {r.get('version'): r.get('date') for r in ET.parse(metainfo).getroot().iter('release')}
    if version not in releases:
        errors.append(f'metainfo: release {version} ({date}) missing, add <release version="{version}" date="{date}">')
    elif releases[version] != date:
        errors.append(f'metainfo: release {version} dated {releases[version]}, the changelog says {date}')

try:
    ET.parse(f'{root}/go-server/build/windows/msix/AppxManifest.xml')
except ET.ParseError as e:
    errors.append(f'AppxManifest.xml: {e}')

for tool, args in (('appstreamcli', ['validate', '--no-net', metainfo]),
                   ('desktop-file-validate', [f'{root}/go-server/build/linux/nats-explorer.desktop'])):
    if shutil.which(tool):
        r = subprocess.run([tool, *args], capture_output=True, text=True)
        if r.returncode != 0:
            errors.append(f'{tool}: {(r.stdout + r.stderr).strip()}')
    else:
        print(f'{tool} not installed, skipped')

if errors:
    print('packaging check failed:')
    for e in errors:
        print('  ' + e)
    sys.exit(1)
print(f'packaging check: metainfo lists {released[0][0]}, manifests ok')
PY
