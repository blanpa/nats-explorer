#!/usr/bin/env bash
# Launches a desktop build, waits until its embedded API answers, checks the UI
# is served and the websocket upgrades, then stops it. On Linux it runs under
# Xvfb when no display is available and takes a screenshot if ImageMagick's
# `import` exists. Usage: scripts/smoke-desktop.sh <path-to-binary> [screenshot.png]
set -euo pipefail
BIN="$1"
SHOT="${2:-}"
LOG="$(mktemp)"
[ -x "$BIN" ] || { echo "not executable: $BIN" >&2; exit 1; }

# Without a display (CI, containers) re-run this whole script inside Xvfb so the
# app and the screenshot tool share the same display and auth cookie.
if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ] && [ -z "${SMOKE_IN_XVFB:-}" ]; then
  command -v xvfb-run >/dev/null || { echo "no display and no xvfb-run" >&2; exit 1; }
  SMOKE_IN_XVFB=1 exec xvfb-run -a -s "-screen 0 1400x900x24" bash "$0" "$@"
fi
"$BIN" >"$LOG" 2>&1 &
APP_PID=$!
trap 'kill $APP_PID 2>/dev/null || true; pkill -P $APP_PID 2>/dev/null || true' EXIT

PORT=""
for _ in $(seq 1 60); do
  PORT=$(sed -n 's/.*API running on http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$LOG" | head -1)
  [ -n "$PORT" ] && break
  kill -0 $APP_PID 2>/dev/null || { echo "app exited early:"; cat "$LOG"; exit 1; }
  sleep 0.5
done
[ -n "$PORT" ] || { echo "API never came up:"; cat "$LOG"; exit 1; }
echo "API port $PORT"
curl -fsS "http://127.0.0.1:$PORT/api/auth" | grep -q required || { echo "auth endpoint broken" >&2; exit 1; }
curl -fsS "http://127.0.0.1:$PORT/" | grep -qi '<div id="root"' || { echo "UI not served" >&2; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "http://127.0.0.1:$PORT/ws")
[ "$code" = 101 ] || { echo "websocket upgrade returned $code" >&2; exit 1; }
echo "API, UI and websocket OK"
# File-backed settings: a value written now must survive a restart of the app.
if curl -fsS "http://127.0.0.1:$PORT/api/app" | grep -q '"storage":"file"'; then
  curl -fsS -X PUT -H 'Content-Type: application/json' -d '{"smoke":true}' "http://127.0.0.1:$PORT/api/settings/ne.smoke" >/dev/null
  kill $APP_PID; wait $APP_PID 2>/dev/null || true
  "$BIN" >"$LOG" 2>&1 &
  APP_PID=$!
  PORT=""
  for _ in $(seq 1 60); do
    PORT=$(sed -n 's/.*API running on http:\/\/127\.0\.0\.1:\([0-9]*\).*/\1/p' "$LOG" | head -1)
    [ -n "$PORT" ] && break
    sleep 0.5
  done
  [ -n "$PORT" ] || { echo "restart failed:"; cat "$LOG"; exit 1; }
  curl -fsS "http://127.0.0.1:$PORT/api/settings" | grep -q '"ne.smoke":{"smoke":true}' || { echo "setting did not survive a restart" >&2; curl -s "http://127.0.0.1:$PORT/api/settings"; exit 1; }
  curl -fsS -X DELETE "http://127.0.0.1:$PORT/api/settings/ne.smoke" >/dev/null
  echo "settings persist across restarts ($(sed -n 's/.*settings in \(.*\) (secrets: \(.*\)).*/\1, secrets: \2/p' "$LOG" | head -1))"
fi
# give the webview a moment to render, then capture it when possible
sleep 4
if [ -n "$SHOT" ] && [ -n "${DISPLAY:-}" ] && command -v import >/dev/null; then
  import -window root "$SHOT" && echo "screenshot $SHOT"
fi
kill -0 $APP_PID 2>/dev/null || { echo "app died during the test:"; cat "$LOG"; exit 1; }
echo "desktop smoke test passed"
