#!/usr/bin/env bash
# Builds the headless server for one or all platforms and packages it the way
# the release workflow ships it (binary with the UI built in + README.txt).
#
#   scripts/build-server.sh                 # all five platforms
#   scripts/build-server.sh linux/amd64     # one platform (GOOS/GOARCH)
#   scripts/build-server.sh current         # this machine, unpackaged, into dist/nats-explorer
#
# Expects client/dist to exist (bun run --filter client build). VERSION defaults
# to the last git tag.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || echo 0.0.0)}"
VERSION="${VERSION#v}"
# Non-release builds (a branch name from workflow_dispatch, "dev", …) get a
# version that is safe in a file name: 0.0.0-<name>.<short sha>.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  VERSION="0.0.0-$(echo "$VERSION" | tr -c 'A-Za-z0-9.\n' '.' | sed 's/^\.*//;s/\.*$//').$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo 0)"
fi
# Stamped so the "source" link in the UI points at the commit this was built
# from, which is what the AGPL asks a network deployment to offer.
COMMIT="${COMMIT:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "")}"
LDFLAGS="-s -w -X main.version=$VERSION -X main.commit=$COMMIT"
OUT="$ROOT/dist/server"
[ -d "$ROOT/client/dist" ] || { echo "client/dist missing: run bun run --filter client build first" >&2; exit 1; }
# The UI is embedded (-tags embedui) from go-server/frontend/dist, the same
# place the desktop build embeds it from.
rm -rf "$ROOT/go-server/frontend/dist"
mkdir -p "$ROOT/go-server/frontend"
cp -r "$ROOT/client/dist" "$ROOT/go-server/frontend/dist"

if [ "${1:-}" = current ]; then
  (cd "$ROOT/go-server" && CGO_ENABLED=0 go build -trimpath -tags embedui -ldflags "$LDFLAGS" -o "$ROOT/dist/nats-explorer" .)
  echo "built dist/nats-explorer (UI built in)"
  exit 0
fi

targets="linux/amd64 linux/arm64 windows/amd64 darwin/amd64 darwin/arm64"
[ -n "${1:-}" ] && targets="$1"
mkdir -p "$OUT"
for t in $targets; do
  goos="${t%/*}"; goarch="${t#*/}"
  case "$goos-$goarch" in
    linux-amd64) name=linux-x64;; linux-arm64) name=linux-arm64;; windows-amd64) name=windows-x64;;
    darwin-amd64) name=macos-x64;; darwin-arm64) name=macos-arm64;; *) name="$goos-$goarch";;
  esac
  ext=""; [ "$goos" = windows ] && ext=.exe
  pkg="nats-explorer-server-$VERSION-$name"
  rm -rf "$OUT/$pkg"; mkdir -p "$OUT/$pkg"
  (cd "$ROOT/go-server" && CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -tags embedui -ldflags "$LDFLAGS" -o "$OUT/$pkg/nats-explorer$ext" .)
  cat > "$OUT/$pkg/README.txt" <<TXT
NATS Explorer $VERSION, server build for $name.
Run the binary; it serves the UI on http://localhost:3002. The UI is built in,
the binary needs no other file and can be copied anywhere on its own.
Environment: PORT (default 3002), PUBLIC_PATH (serve the UI from a folder instead),
AUTH_TOKEN (optional API token),
STORAGE_DIR (keep connections and templates on the server), NO_KEYRING.
TXT
  if [ "$goos" = windows ]; then
    (cd "$OUT" && { command -v zip >/dev/null && zip -qr "$pkg.zip" "$pkg" || 7z a -tzip -bso0 -bsp0 "$pkg.zip" "$pkg"; })
  else
    tar -C "$OUT" -czf "$OUT/$pkg.tar.gz" "$pkg"
  fi
  rm -rf "$OUT/$pkg"
  echo "packaged $pkg"
done
ls -la "$OUT"
