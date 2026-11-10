#!/usr/bin/env bash
# Flatpak packaging for Flathub. Flathub builds from source without network
# access, so everything the build downloads has to be listed with a checksum:
# the Go modules (from go.sum, served to `go build` as a file:// module proxy)
# and the npm packages of the UI (Bun's lockfile has no Flatpak tooling, so an
# npm lockfile is resolved from the same package.json files).
#
#   scripts/flatpak.sh build                 test build of the working tree in Flathub's
#                                            builder image (Docker), then the desktop smoke test
#   scripts/flatpak.sh sources [dir]         only the source lists (default dir: dist/flatpak)
#   scripts/flatpak.sh flathub v1.2.3 [dir]  manifest and source lists for the Flathub
#                                            repository, built from the tag (default dir:
#                                            dist/flathub)
#
# Needs python3, npm, uv (for flatpak-node-generator) and network access.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_ID=io.github.blanpa.nats-explorer
# Keep in step with runtime-version in the manifest: GNOME 51 is built on
# the Freedesktop SDK 26.08, whose branch the SDK extensions follow.
# Image and generator are pinned like the release workflow's actions: what
# builds the package does not change under the same name.
IMAGE=ghcr.io/flathub-infra/flatpak-github-actions:gnome-51@sha256:78d969b18225ae107ca29497bf09c4a3f791e5f1838a9a912a529d0024fb6210
SDK_BRANCH=26.08
# flatpak-builder-tools has no releases: a commit of master.
NODE_GENERATOR="git+https://github.com/flatpak/flatpak-builder-tools.git@9d86d336a39b9af38b86f114b6ce5820fe260f91#subdirectory=node"

# Reads a file of the app either from the working tree or from a git ref.
REF=""
src() {
  if [ -n "$REF" ]; then git -C "$ROOT" show "$REF:$1"; else cat "$ROOT/$1"; fi
}

# Writes package-lock.json, npm-package.json, node-sources.json and go-sources.json to $1.
sources() {
  local out="$1" tmp
  mkdir -p "$out"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  # npm knows no "workspace:" protocol; the build makes the same change to
  # client/package.json before `npm ci`, so the lockfile matches it.
  mkdir -p "$tmp/shared" "$tmp/client"
  src shared/package.json > "$tmp/shared/package.json"
  src client/package.json | sed 's/"workspace:\*"/"*"/' > "$tmp/client/package.json"
  local version
  version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$tmp/client/package.json")"
  # Only what the UI build needs: the dev tooling and e2e workspaces stay out.
  cat > "$out/npm-package.json" <<JSON
{
  "name": "nats-explorer",
  "version": "$version",
  "private": true,
  "workspaces": ["shared", "client"]
}
JSON
  cp "$out/npm-package.json" "$tmp/package.json"
  (cd "$tmp" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund \
    --registry=https://registry.npmjs.org/ >/dev/null)
  cp "$tmp/package-lock.json" "$out/package-lock.json"
  uvx --quiet --from "$NODE_GENERATOR" flatpak-node-generator npm "$out/package-lock.json" -o "$out/node-sources.json" \
    > "$tmp/node-generator.log" 2>&1 || { cat "$tmp/node-generator.log" >&2; return 1; }
  echo "$(grep -c '"url"' "$out/node-sources.json") npm packages"

  src go-server/go.sum > "$tmp/go.sum"
  python3 - "$tmp/go.sum" "$out/go-sources.json" "${GOMODCACHE:-$HOME/go/pkg/mod}" <<'PY'
import hashlib, json, os, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

gosum, out, modcache = sys.argv[1:4]

def escape(path):
    # The module proxy's case encoding: an upper-case letter becomes "!" plus
    # the lower-case one.
    return re.sub(r'[A-Z]', lambda m: '!' + m.group(0).lower(), path)

# Every zip and go.mod go.sum lists: a superset of what the build reads
# (test-only modules included), and go.sum still verifies each file.
files = set()
for line in open(gosum):
    mod, ver, _ = line.split()
    if ver.endswith('/go.mod'):
        files.add((escape(mod), escape(ver[:-len('/go.mod')]) + '.mod'))
    else:
        files.add((escape(mod), escape(ver) + '.zip'))

def entry(f):
    mod, name = f
    rel = f'{mod}/@v/{name}'
    url = f'https://proxy.golang.org/{rel}'
    # The module cache keeps the proxy's files byte for byte.
    cached = os.path.join(modcache, 'cache', 'download', rel)
    if os.path.exists(cached):
        data = open(cached, 'rb').read()
    else:
        with urllib.request.urlopen(url, timeout=60) as r:
            data = r.read()
    return {'type': 'file', 'url': url, 'sha256': hashlib.sha256(data).hexdigest(),
            'dest': f'goproxy/{mod}/@v', 'dest-filename': name}

with ThreadPoolExecutor(8) as pool:
    entries = list(pool.map(entry, sorted(files)))
json.dump(entries, open(out, 'w'), indent=2)
print(f'{len(entries)} Go module files')
PY
}

# Copies the manifest to $1 with the app's source filled in ($2, YAML lines).
manifest() {
  local out="$1" source="$2"
  python3 - "$ROOT/packaging/flatpak/$APP_ID.yml" "$out/$APP_ID.yml" "$source" <<'PY'
import sys
src, dst, source = sys.argv[1:4]
text = open(src).read()
marker = "      - '@APP_SOURCE@'\n"
assert marker in text, 'placeholder missing in the manifest'
text = text.replace("      # @APP_SOURCE@ is replaced by scripts/flatpak.sh\n", "")
lines = source.strip('\n').split('\n')
block = '      - ' + lines[0] + '\n' + ''.join('        ' + l + '\n' for l in lines[1:])
open(dst, 'w').write(text.replace(marker, block))
PY
}

case "${1:-}" in
  build)
    OUT="$ROOT/dist/flatpak"
    sources "$OUT"
    manifest "$OUT" "type: dir
path: ../..
skip:
  - .git
  - dist
  - node_modules
  - client/node_modules
  - client/dist
  - shared/node_modules
  - dev/node_modules
  - e2e/node_modules
  - go-server/build/bin
  - go-server/frontend"
    # Root inside the container; what it leaves in dist/flatpak is handed back to the caller.
    docker run --rm --privileged -v "$ROOT:/src" -w /src/dist/flatpak "$IMAGE" bash -euo pipefail -c "
      trap 'chown -R $(id -u):$(id -g) /src/dist/flatpak' EXIT
      # The image has the runtime and SDK; only the SDK extensions come from
      # Flathub (--install-deps-from would also update the whole SDK first).
      flatpak install --system -y --noninteractive flathub \
        org.freedesktop.Sdk.Extension.golang//$SDK_BRANCH org.freedesktop.Sdk.Extension.node24//$SDK_BRANCH
      flatpak-builder --system --force-clean --disable-rofiles-fuse \
        --repo=repo build-dir $APP_ID.yml
      flatpak build-bundle repo nats-explorer.flatpak $APP_ID
      flatpak install --system -y --noninteractive --no-deps --no-related ./nats-explorer.flatpak
      printf '#!/bin/sh\nexec flatpak run $APP_ID \"\$@\"\n' > /tmp/run-app && chmod +x /tmp/run-app
      # Outside /src: the smoke test would compare a Bun build in client/dist
      # with the assets of this npm build.
      cd /tmp && EXPECT_DISTRIBUTION=flatpak /src/scripts/smoke-desktop.sh /tmp/run-app
    "
    ls -la "$OUT/nats-explorer.flatpak"
    ;;
  sources)
    sources "${2:-$ROOT/dist/flatpak}"
    ;;
  flathub)
    TAG="${2:?usage: scripts/flatpak.sh flathub <tag> [dir]}"
    OUT="${3:-$ROOT/dist/flathub}"
    COMMIT="$(git -C "$ROOT" rev-list -n 1 "$TAG")"
    REF="$TAG"
    sources "$OUT"
    manifest "$OUT" "type: git
url: https://github.com/blanpa/nats-explorer.git
tag: $TAG
commit: $COMMIT"
    echo "Flathub files for $TAG ($COMMIT) in $OUT"
    ls "$OUT"
    ;;
  *)
    sed -n '2,16p' "$0" >&2
    exit 2
    ;;
esac
