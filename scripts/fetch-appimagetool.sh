#!/usr/bin/env bash
# Puts appimagetool and the AppImage runtime into a directory, both at a fixed
# release and checked against their SHA-256. The runtime is the part of every
# AppImage that runs first; without --runtime-file appimagetool downloads it
# itself, and gets whatever the "continuous" release holds that day.
#
#   scripts/fetch-appimagetool.sh DIR   -> DIR/appimagetool, DIR/appimage-runtime-x86_64
#
# scripts/build-desktop.sh passes the runtime next to appimagetool on. A newer
# version is a change here: version and checksum, both from the release page.
set -euo pipefail
DIR="${1:?usage: $0 DIR}"
APPIMAGETOOL_VERSION=1.9.1
APPIMAGETOOL_SHA256=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
RUNTIME_VERSION=20251108
RUNTIME_SHA256=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d

# fetch URL SHA256 DEST: a file that does not match is not kept.
fetch() {
  curl -fsSL -o "$3.part" "$1"
  if ! echo "$2  $3.part" | sha256sum -c --quiet -; then
    rm -f "$3.part"
    echo "checksum mismatch: $1" >&2
    exit 1
  fi
  mv "$3.part" "$3"
}

mkdir -p "$DIR"
fetch "https://github.com/AppImage/appimagetool/releases/download/$APPIMAGETOOL_VERSION/appimagetool-x86_64.AppImage" \
  "$APPIMAGETOOL_SHA256" "$DIR/appimagetool"
chmod +x "$DIR/appimagetool"
fetch "https://github.com/AppImage/type2-runtime/releases/download/$RUNTIME_VERSION/runtime-x86_64" \
  "$RUNTIME_SHA256" "$DIR/appimage-runtime-x86_64"
echo "appimagetool $APPIMAGETOOL_VERSION and runtime $RUNTIME_VERSION in $DIR"
