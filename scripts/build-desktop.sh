#!/usr/bin/env bash
# Builds the desktop app for the current platform (or cross-compiles Windows)
# and packages it the way the release workflow does.
#
#   scripts/build-desktop.sh linux      -> dist/desktop/*.AppImage, *.deb, *.tar.gz
#   scripts/build-desktop.sh windows    -> dist/desktop/*-setup.exe (needs makensis), *.zip
#   scripts/build-desktop.sh macos      -> dist/desktop/*.dmg (macOS only)
#   scripts/build-desktop.sh --docker linux|windows   run the Linux/Windows build in the builder image
#
# Expects client/dist to exist (pnpm --filter client build). VERSION defaults to
# the last git tag; set VERSION=1.2.3 to override.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-linux}"

if [ "$TARGET" = "--docker" ]; then
  shift
  docker build -t nats-explorer-desktop-builder -f "$ROOT/scripts/desktop-builder.Dockerfile" "$ROOT/scripts"
  exec docker run --rm -v "$ROOT:/src" -w /src -e VERSION="${VERSION:-}" nats-explorer-desktop-builder scripts/build-desktop.sh "${1:-linux}"
fi

VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || echo 0.0.0)}"
VERSION="${VERSION#v}"
# Non-release builds (a branch name from workflow_dispatch, "dev", …) get a
# version that package formats accept: 0.0.0-<name>.<short sha>.
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  VERSION="0.0.0-$(echo "$VERSION" | tr -c 'A-Za-z0-9.\n' '.' | sed 's/^\.*//;s/\.*$//').$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo 0)"
fi
# NSIS version info and CFBundleVersion need plain X.Y.Z; pre-release suffixes stay in file names and the window title.
NUMERIC_VERSION="$(echo "$VERSION" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')"
echo "version $VERSION (package metadata $NUMERIC_VERSION)"
APP="NATS Explorer"
BIN=nats-explorer
OUT="$ROOT/dist/desktop"
LDFLAGS="-s -w -X main.version=$VERSION"
mkdir -p "$OUT"

# Installer metadata (NSIS version info, Info.plist) comes from wails.json; stamp the version there for this build.
WAILS_JSON="$ROOT/go-server/wails.json"
cp "$WAILS_JSON" "$WAILS_JSON.orig"
trap 'mv "$WAILS_JSON.orig" "$WAILS_JSON"' EXIT
sed -i.bak "s/\"productVersion\": \"[^\"]*\"/\"productVersion\": \"$NUMERIC_VERSION\"/" "$WAILS_JSON" && rm -f "$WAILS_JSON.bak"

[ -d "$ROOT/client/dist" ] || { echo "client/dist missing: run pnpm --filter client build first" >&2; exit 1; }
rm -rf "$ROOT/go-server/frontend/dist"
mkdir -p "$ROOT/go-server/frontend"
cp -r "$ROOT/client/dist" "$ROOT/go-server/frontend/dist"

cd "$ROOT/go-server"
wails_build() {
  # -s: frontend is prebuilt; -skipbindings: the app exposes no Go bindings, the UI talks HTTP/WS.
  wails build -s -skipbindings -clean -trimpath -tags desktop -ldflags "$LDFLAGS" "$@"
}

case "$TARGET" in
  linux)
    # Ubuntu 24.04 and the GitHub runner ship webkit2gtk 4.1; Wails defaults to 4.0 without this tag.
    wails_build -platform linux/amd64 -tags desktop,webkit2_41 -o "$BIN"
    BINARY="build/bin/$BIN"
    file "$BINARY"
    # tarball
    tar -C build/bin -czf "$OUT/nats-explorer-desktop-$VERSION-linux-x64.tar.gz" "$BIN"
    # .deb
    DEB="$ROOT/dist/deb"
    rm -rf "$DEB"; mkdir -p "$DEB/DEBIAN" "$DEB/usr/bin" "$DEB/usr/share/applications" "$DEB/usr/share/icons/hicolor/512x512/apps"
    install -m 755 "$BINARY" "$DEB/usr/bin/$BIN"
    cp build/linux/nats-explorer.desktop "$DEB/usr/share/applications/"
    cp build/linux/icon-512.png "$DEB/usr/share/icons/hicolor/512x512/apps/$BIN.png"
    cat > "$DEB/DEBIAN/control" <<CTRL
Package: nats-explorer
Version: $VERSION
Section: net
Priority: optional
Architecture: amd64
Depends: libwebkit2gtk-4.1-0, libgtk-3-0
Maintainer: NATS Explorer contributors <noreply@example.invalid>
Homepage: https://github.com/blanpa/nats-explorer
Description: Desktop explorer for NATS
 Browse subjects, JetStream streams, Key-Value and Object Stores, micro
 services and server monitoring of NATS servers, clusters and leaf nodes.
CTRL
    dpkg-deb --build --root-owner-group "$DEB" "$OUT/nats-explorer-desktop-$VERSION-linux-x64.deb"
    # AppImage
    APPDIR="$ROOT/dist/AppDir"
    rm -rf "$APPDIR"; mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/512x512/apps"
    install -m 755 "$BINARY" "$APPDIR/usr/bin/$BIN"
    cp build/linux/nats-explorer.desktop "$APPDIR/" 
    cp build/linux/nats-explorer.desktop "$APPDIR/usr/share/applications/"
    cp build/linux/icon-512.png "$APPDIR/$BIN.png"
    cp build/linux/icon-512.png "$APPDIR/usr/share/icons/hicolor/512x512/apps/$BIN.png"
    ln -sf "usr/bin/$BIN" "$APPDIR/AppRun"
    ln -sf "$BIN.png" "$APPDIR/.DirIcon"
    APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 appimagetool --no-appstream "$APPDIR" "$OUT/nats-explorer-desktop-$VERSION-linux-x64.AppImage"
    ;;
  windows)
    # Cross-compiles from Linux too (no CGO on Windows). -nsis needs makensis on PATH.
    NSIS=""
    command -v makensis >/dev/null && NSIS="-nsis"
    wails_build -platform windows/amd64 -o "$BIN.exe" -webview2 download $NSIS
    (cd build/bin && zip -q "$OUT/nats-explorer-desktop-$VERSION-windows-x64.zip" "$BIN.exe")
    if [ -n "$NSIS" ]; then
      mv build/bin/*-installer.exe "$OUT/nats-explorer-desktop-$VERSION-windows-x64-setup.exe"
    else
      echo "makensis not found: installer skipped, portable zip only" >&2
    fi
    ;;
  macos)
    wails_build -platform darwin/universal
    APPBUNDLE="$(ls -d build/bin/*.app | head -1)"
    [ -d "$APPBUNDLE" ] || { echo "no .app produced" >&2; exit 1; }
    ls "$APPBUNDLE/Contents/MacOS"
    # Ad-hoc signature so the bundle is not reported as damaged; users still need right-click > Open (unsigned).
    codesign --force --deep --sign - "$APPBUNDLE"
    STAGE="$ROOT/dist/dmg"; rm -rf "$STAGE"; mkdir -p "$STAGE"
    cp -R "$APPBUNDLE" "$STAGE/"
    ln -s /Applications "$STAGE/Applications"
    hdiutil create -volname "$APP" -srcfolder "$STAGE" -ov -format UDZO "$OUT/nats-explorer-desktop-$VERSION-macos-universal.dmg"
    (cd build/bin && zip -qry "$OUT/nats-explorer-desktop-$VERSION-macos-universal.zip" "$(basename "$APPBUNDLE")")
    ;;
  *)
    echo "unknown target $TARGET" >&2; exit 2;;
esac
ls -la "$OUT"
