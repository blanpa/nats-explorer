#!/usr/bin/env bash
# Tests the desktop app's in-app update end to end with real packages, in the
# builder image: builds an old and a new version with a test release key,
# serves the new one from a fake GitHub over HTTPS, and has the old one update
# itself, restart, go back and forward again, from the network and from files,
# as the Linux tarball and as an AppImage. Releases that are unsigned, signed
# with another key, edited after signing or with a swapped package have to be
# refused, with the installation untouched. The repository's release key is
# replaced in the container's copy only; nothing is signed with the real one.
#
#   scripts/test-update.sh     (needs Docker and client/dist)
#
# Windows and macOS replace themselves differently (internal/update/put.go);
# those paths are covered by the Go tests, not here.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OLD=1.0.0
NEW=1.0.1

if [ "${1:-}" != --inside ]; then
  set -e
  [ -d "$ROOT/client/dist" ] || { echo "client/dist missing: run bun run --filter client build first" >&2; exit 1; }
  docker build -q -t nats-explorer-desktop-builder -f "$ROOT/scripts/desktop-builder.Dockerfile" "$ROOT/scripts" >/dev/null
  NET="ne-update-test-$$"
  docker network create "$NET" >/dev/null
  trap 'docker rm -f "$NET-nats" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1' EXIT
  docker run -d --rm --name "$NET-nats" --network "$NET" --network-alias nats nats:latest --jetstream >/dev/null
  # A copy of the working tree goes in, so the builds leave no root-owned
  # files behind in it.
  cd "$ROOT"
  { git ls-files -co --exclude-standard; find client/dist -type f; } |
    tar -cf - --ignore-failed-read -T - 2>/dev/null |
    docker run -i --rm --network "$NET" \
      --add-host api.github.com:127.0.0.1 --add-host github.com:127.0.0.1 \
      nats-explorer-desktop-builder \
      bash -c 'mkdir -p /src && tar -xf - -C /src && cd /src && scripts/test-update.sh --inside'
  exit $?
fi

PASS=0
FAIL=0
ok() { echo "  PASS  $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $*"; FAIL=$((FAIL + 1)); }
check() {
  local desc="$1"
  shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}
step() { echo; echo "== $*"; }
field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
sum() { sha256sum "$1" | cut -c1-64; }

W=/work
mkdir -p $W/rel
git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m t

step "a test release key in place of the real one"
cp go-server/internal/update/release-key.pem $W/real-release-key.pem
openssl genpkey -algorithm ed25519 -out $W/test-key.pem
openssl pkey -in $W/test-key.pem -pubout -out go-server/internal/update/release-key.pem
openssl genpkey -algorithm ed25519 -out $W/other-key.pem

step "build $OLD and $NEW"
for v in $OLD $NEW; do
  VERSION=$v scripts/build-desktop.sh linux >$W/build-$v.log 2>&1 || { tail -30 $W/build-$v.log; exit 1; }
done
ls dist/desktop

# mkrel NAME VERSION KEY: a release as the release job collects and signs it.
mkrel() {
  local d=$W/rel/$1 v=$2 key=$3
  mkdir -p $d
  cp dist/desktop/*-$v-* $d/
  for f in $d/*; do
    base=$(basename "$f")
    stable=${base/-$v/}
    [ "$stable" != "$base" ] && cp "$f" "$d/$stable"
  done
  (cd $d && sha256sum * >SHA256SUMS.txt)
  if [ -n "$key" ]; then
    openssl pkeyutl -sign -rawin -inkey "$key" -in $d/SHA256SUMS.txt -out $d/SHA256SUMS.txt.sig
  fi
  echo "v$v" >$d/TAG
}

step "releases: good, unsigned, another key, edited checksums, swapped package, same version"
mkrel good $NEW $W/test-key.pem
check "the release job's check accepts the signature" \
  openssl pkeyutl -verify -rawin -pubin -inkey go-server/internal/update/release-key.pem -in $W/rel/good/SHA256SUMS.txt -sigfile $W/rel/good/SHA256SUMS.txt.sig
check "and fails it against the repository's real key" \
  bash -c "! openssl pkeyutl -verify -rawin -pubin -inkey $W/real-release-key.pem -in $W/rel/good/SHA256SUMS.txt -sigfile $W/rel/good/SHA256SUMS.txt.sig >/dev/null 2>&1"
mkrel unsigned $NEW ""
mkrel wrongkey $NEW $W/other-key.pem
mkrel tamperedsums $NEW $W/test-key.pem
sed -i -E "/$NEW-linux-x64.tar.gz/ { s/^0/X/; s/^[^X]/0/; s/^X/1/ }" $W/rel/tamperedsums/SHA256SUMS.txt
check "the edited checksums differ from the signed ones" bash -c "! cmp -s $W/rel/good/SHA256SUMS.txt $W/rel/tamperedsums/SHA256SUMS.txt"
mkrel tamperedasset $NEW $W/test-key.pem
cp dist/desktop/nats-explorer-desktop-$OLD-linux-x64.tar.gz $W/rel/tamperedasset/nats-explorer-desktop-$NEW-linux-x64.tar.gz
mkrel same $OLD $W/test-key.pem

step "fake GitHub over HTTPS, trusted through a test CA"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 -subj /CN=test-ca \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign -keyout $W/ca.key -out $W/ca.crt 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj /CN=github.com -keyout $W/gh.key -out $W/gh.csr 2>/dev/null
printf 'subjectAltName=DNS:api.github.com,DNS:github.com\nextendedKeyUsage=serverAuth\n' >$W/gh.ext
openssl x509 -req -in $W/gh.csr -CA $W/ca.crt -CAkey $W/ca.key -CAcreateserial -days 1 -extfile $W/gh.ext -out $W/gh.crt 2>/dev/null
cp $W/ca.crt /usr/local/share/ca-certificates/test-ca.crt && update-ca-certificates >/dev/null 2>&1
go build -o $W/fake-github scripts/fake-github.go
RELEASE_DIR=$W/rel CERT=$W/gh.crt KEY=$W/gh.key $W/fake-github >$W/fake-github.log 2>&1 &
ln -sfn $W/rel/good $W/rel/current
sleep 1
check "the fake answers as api.github.com" \
  bash -c "curl -sf https://api.github.com/repos/blanpa/nats-explorer/releases/latest | grep -q '\"tag_name\":\"v$NEW\"'"

Xvfb :99 -screen 0 1400x900x24 >/dev/null 2>&1 &
export DISPLAY=:99
sleep 1

# listeners: ports open on 127.0.0.1, from /proc (the image has no ss).
listeners() {
  tail -n +2 /proc/net/tcp | while read -r _ local _ st _; do
    [ "$st" = 0A ] && [ "${local%%:*}" = 0100007F ] && printf '%d\n' "0x${local##*:}"
  done
}
# find_app: the port of the app, which picks a free one at every start.
find_app() {
  for _ in $(seq 1 90); do
    for p in $(listeners); do
      curl -sf -m 2 "http://127.0.0.1:$p/api/app" >/dev/null 2>&1 && { echo "$p"; return 0; }
    done
    sleep 0.5
  done
  return 1
}
# app_pid: the newest process of the app (the image has no pgrep).
app_pid() {
  for p in /proc/[0-9]*; do
    e=$(readlink "$p/exe" 2>/dev/null) || continue
    case "$e" in */nats-explorer | *"/nats-explorer (deleted)") echo "${p#/proc/}" ;; esac
  done | sort -n | tail -1
}
kill_apps() {
  for p in /proc/[0-9]*; do
    e=$(readlink "$p/exe" 2>/dev/null) || continue
    case "$e" in *nats-explorer* | *.AppImage) kill "${p#/proc/}" 2>/dev/null ;; esac
  done
  sleep 2
}
api() { curl -s -m 20 "http://127.0.0.1:$PORT/api$1" "${@:2}"; }
version() { api /app | field version; }
start_app() {
  "$@" >>$W/app.log 2>&1 &
  PORT=$(find_app)
  APP_PID=$(app_pid)
}
# restart: the update's own restart; the old process exits, the new one comes up.
restart() {
  local old=$APP_PID oldport=$PORT
  api /update/restart -X POST >/dev/null
  for _ in $(seq 1 60); do kill -0 "$old" 2>/dev/null || break; sleep 0.5; done
  for _ in $(seq 1 60); do
    PORT=$(find_app) && [ "$PORT" != "$oldport" ] && break
    sleep 0.5
  done
  APP_PID=$(app_pid)
}
wait_connected() {
  for _ in $(seq 1 40); do api /connections | grep -q '"connected":true' && return 0; sleep 0.5; done
  return 1
}
# try_release NAME: points the fake at a release and asks the app to update.
try_release() {
  ln -sfn $W/rel/$1 $W/rel/current
  api /update -X POST >/dev/null
  local s=""
  for _ in $(seq 1 240); do
    s=$(api /update)
    case "$s" in *'"state":"ready"'* | *'"state":"failed"'*) break ;; esac
    sleep 0.5
  done
  echo "$s"
}

step "tarball: $OLD unpacked to /opt/ne-tar, a saved NATS connection open"
INST=/opt/ne-tar
mkdir -p $INST $W/new
tar -xzf dist/desktop/nats-explorer-desktop-$OLD-linux-x64.tar.gz -C $INST
tar -xzf dist/desktop/nats-explorer-desktop-$NEW-linux-x64.tar.gz -C $W/new
OLD_SUM=$(sum $INST/nats-explorer)
NEW_SUM=$(sum $W/new/nats-explorer)
rm -rf ~/.config/nats-explorer
start_app $INST/nats-explorer
check "$OLD runs" [ "$(version)" = $OLD ]
st=$(api /update)
check "the update is offered for the tarball" grep -q '"supported":true,"kind":"tarball"' <<<"$st"
CONN='{"id":"nats1","name":"test-nats","servers":["nats://nats:4222"],"subscriptions":[">"]}'
api /settings/ne.connections.v2 -X PUT -H 'Content-Type: application/json' -d "[$CONN]" >/dev/null
api /connect -X POST -H 'Content-Type: application/json' -d "$CONN" >/dev/null
check "the connection to NATS is open" wait_connected
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: http://evil.example' "http://127.0.0.1:$PORT/api/update")
check "a page of another origin cannot start it ($code)" [ "$code" = 403 ]

step "refused while $OLD runs"
s=$(try_release same)
check "the same version: $(field error <<<"$s")" grep -q 'is the newest release' <<<"$s"
s=$(try_release unsigned)
check "unsigned: $(field error <<<"$s")" grep -q 'is not signed' <<<"$s"
s=$(try_release wrongkey)
check "another key: $(field error <<<"$s")" grep -q "carry the release key" <<<"$s"
s=$(try_release tamperedsums)
check "checksums edited after signing: $(field error <<<"$s")" grep -q "carry the release key" <<<"$s"
s=$(try_release tamperedasset)
check "a swapped package: $(field error <<<"$s")" grep -q "checksum is" <<<"$s"
check "the installation is untouched" [ "$(sum $INST/nats-explorer)" = "$OLD_SUM" ]
check "and nothing is left next to it" [ "$(ls -A $INST)" = nats-explorer ]

step "update $OLD -> $NEW"
s=$(try_release good)
check "$NEW downloaded, checked and in place" grep -q "\"state\":\"ready\",\"version\":\"$NEW\"" <<<"$s"
check "the binary is $NEW's" [ "$(sum $INST/nats-explorer)" = "$NEW_SUM" ]
check "$OLD is kept as .nats-explorer.previous" [ "$(sum $INST/.nats-explorer.previous)" = "$OLD_SUM" ]
check "and noted as $OLD" [ "$(cat $INST/.nats-explorer.previous.version)" = $OLD ]
check "$OLD runs on until the restart" [ "$(version)" = $OLD ]

step "restart"
restart
check "$NEW runs" [ "$(version)" = $NEW ]
check "the connection opened again by itself" wait_connected
check "the saved connection is still saved" bash -c "curl -s http://127.0.0.1:$PORT/api/settings | grep -q test-nats"
check "the history database is still there" test -s ~/.config/nats-explorer/history.db
check "going back to $OLD is offered" grep -q "\"previous\":\"$OLD\"" <<<"$(api /update)"

step "back to $OLD"
s=$(api /update/rollback -X POST)
check "$OLD is in place again" grep -q "\"state\":\"ready\",\"version\":\"$OLD\"" <<<"$s"
check "the binary is $OLD's" [ "$(sum $INST/nats-explorer)" = "$OLD_SUM" ]
restart
check "$OLD runs" [ "$(version)" = $OLD ]
check "the connection opened again" wait_connected
check "going forward to $NEW is offered" grep -q "\"previous\":\"$NEW\"" <<<"$(api /update)"

step "without internet: the release from files, the package renamed on the way"
cp $W/rel/good/nats-explorer-desktop-$NEW-linux-x64.tar.gz $W/from-stick.tar.gz
upload() {
  curl -s -o $W/upload.json -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/update/file" \
    -F "files=@$1" -F "files=@$2/SHA256SUMS.txt" -F "files=@$2/SHA256SUMS.txt.sig"
}
code=$(upload $W/from-stick.tar.gz $W/rel/wrongkey)
check "checksums signed with another key are refused ($code: $(field error <$W/upload.json))" [ "$code" = 422 ]
code=$(upload $W/from-stick.tar.gz $W/rel/good)
check "the signed release is taken ($code)" grep -q "\"state\":\"ready\",\"version\":\"$NEW\"" $W/upload.json
restart
check "$NEW runs" [ "$(version)" = $NEW ]
code=$(upload $W/rel/same/nats-explorer-desktop-$OLD-linux-x64.tar.gz $W/rel/same)
check "an older signed release is refused ($code: $(field error <$W/upload.json))" [ "$code" = 422 ]
kill_apps

step "AppImage: $OLD -> $NEW"
export APPIMAGE_EXTRACT_AND_RUN=1
AI=/opt/ne-appimage/NATS-Explorer.AppImage
mkdir -p /opt/ne-appimage
cp dist/desktop/nats-explorer-desktop-$OLD-linux-x64.AppImage $AI
rm -rf ~/.config/nats-explorer
start_app $AI
check "$OLD runs" [ "$(version)" = $OLD ]
check "the update is offered for the AppImage" grep -q '"kind":"appimage"' <<<"$(api /update)"
s=$(try_release good)
check "$NEW is in place" grep -q "\"state\":\"ready\",\"version\":\"$NEW\"" <<<"$s"
check "the AppImage is $NEW's" [ "$(sum $AI)" = "$(sum dist/desktop/nats-explorer-desktop-$NEW-linux-x64.AppImage)" ]
check "and executable" test -x $AI
restart
check "$NEW runs" [ "$(version)" = $NEW ]
kill_apps
unset APPIMAGE_EXTRACT_AND_RUN

step ".deb: left to the package manager"
dpkg -i dist/desktop/nats-explorer-desktop-$OLD-linux-x64.deb >/dev/null 2>&1
start_app /usr/bin/nats-explorer
st=$(api /update)
check "no update offered: $(field reason <<<"$st")" grep -q 'package manager' <<<"$st"
kill_apps

echo
echo "$PASS passed, $FAIL failed"
if [ $FAIL -gt 0 ]; then
  echo "--- app log"
  tail -40 $W/app.log
  exit 1
fi
