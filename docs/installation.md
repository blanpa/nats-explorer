---
layout: default
title: Installation
nav_order: 2
---

# Installation

NATS Explorer runs as a desktop application, as a Docker container, or as a standalone server binary. The download links below always point at the newest release; the [Releases page](https://github.com/blanpa/nats-explorer/releases) carries the same files with the version in their name, plus a [`SHA256SUMS.txt`](https://github.com/blanpa/nats-explorer/releases/latest/download/SHA256SUMS.txt) over all of them.

---

## Desktop app

| Platform | Download | Notes |
|:-- |:-- |:-- |
| Windows 10/11 | [installer (.exe)](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-windows-x64-setup.exe) · [portable (.zip)](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-windows-x64.zip) | Per-user installer, no admin rights, Start-menu entry and uninstaller. Uses the Edge WebView2 runtime (downloaded on first start if missing). Not code-signed: SmartScreen shows "unknown publisher", choose *More info → Run anyway*. |
| macOS 11+ | [disk image (.dmg)](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-macos-universal.dmg) · [app bundle (.zip)](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-macos-universal.zip) | Intel and Apple Silicon. Drag to *Applications*. Not notarized: right-click → *Open* on first start, or `xattr -dr com.apple.quarantine "/Applications/NATS Explorer.app"`. |
| Linux | [AppImage](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-linux-x64.AppImage) · [.deb](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-linux-x64.deb) · [.tar.gz](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-linux-x64.tar.gz) | AppImage: `chmod +x` and run. Debian/Ubuntu: `sudo apt install ./nats-explorer-desktop-linux-x64.deb`. Needs webkit2gtk 4.1 (Ubuntu 22.04+, Debian 12+, Fedora 37+). |

### Where the desktop app keeps its data

| | Location |
|:-- |:-- |
| Linux | `~/.config/nats-explorer/` |
| Windows | `%AppData%\nats-explorer\` |
| macOS | `~/Library/Application Support/nats-explorer/` |

`settings.json` holds connections, request templates and preferences. Credentials (tokens, passwords, NKey seeds, credentials files, TLS keys) go to the system keyring (Secret Service, Keychain, Credential Manager); where none is available they are written to `secrets.json`, readable only by your user. Back up the directory to keep your setup; delete it to start fresh.

`history.db` next to it holds the recorded messages, so the history survives a restart. It is on by default and keeps 3 days; the gear at the bottom of the rail opens the settings, where it can be given another retention, switched off, or deleted from disk. Switched off, the history is what fits in memory and is gone when the app closes.

---

## Docker

### With NATS server included

```bash
docker compose up -d
```

Starts a NATS server (port 4222, monitoring on 8222) and NATS Explorer (port 3002).

### Bring your own NATS

```bash
docker compose -f docker-compose.standalone.yml up -d
# or
docker run -d -p 3002:3002 ghcr.io/blanpa/nats-explorer:latest
```

Open `http://localhost:3002` and add your server in the connection dialog. In the web UI, connections and templates live in the browser's local storage unless `STORAGE_DIR` is set (see below).

---

## Server binary

One binary plus the UI as `public/` next to it, found automatically.

| Target | Download |
|:-- |:-- |
| Linux x64 | [nats-explorer-server-linux-x64.tar.gz](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-linux-x64.tar.gz) |
| Linux arm64 | [nats-explorer-server-linux-arm64.tar.gz](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-linux-arm64.tar.gz) |
| macOS arm64 | [nats-explorer-server-macos-arm64.tar.gz](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-macos-arm64.tar.gz) |
| macOS x64 | [nats-explorer-server-macos-x64.tar.gz](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-macos-x64.tar.gz) |
| Windows x64 | [nats-explorer-server-windows-x64.zip](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-windows-x64.zip) |

```bash
curl -fL -o nats-explorer-server.tar.gz \
  https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-linux-x64.tar.gz
mkdir -p nats-explorer && tar xzf nats-explorer-server.tar.gz -C nats-explorer --strip-components=1
cd nats-explorer && ./nats-explorer
# Windows: extract the zip and run nats-explorer.exe
```

---

## Configuration

| Variable | Default | Description |
|:-- |:-- |:-- |
| `PORT` | `3002` | HTTP port of the web UI and API |
| `PUBLIC_PATH` | auto | UI files; defaults to `public/` next to the binary or `client/dist` in a checkout |
| `AUTH_TOKEN` | unset | When set, every API and websocket call needs this token. The UI asks for it once; the backend answers with a session cookie that lasts a day |
| `AUTH_USERS` | unset | Path of a users file (`name:role:bcrypt-hash` per line, roles `admin` and `viewer`). The UI asks for a login; viewers see everything but cannot publish or change anything. `nats-explorer hash-password` prints a hash |
| `STORAGE_DIR` | unset | Keep connections, templates and preferences in this directory instead of the browser (single-user servers). Same layout as the desktop app. Saved connections marked "Connect when the server starts" are opened by the backend at start |
| `NO_KEYRING` | unset | With `STORAGE_DIR`: always use `secrets.json` instead of the system keyring |
| `BASE_PATH` | unset | Serve the UI, the API and the websocket under a prefix, e.g. `/nats`. For a reverse proxy that forwards the prefix instead of stripping it; no rewrite rule is needed, the app builds every URL with it |
| `PPROF` | unset | When set, Go's profiler is served under `/debug/pprof` (load investigations only) |
| `SOURCE_URL` | this project | Where the source of this build is offered. The status bar and the login dialog link it as "source"; unset, it points at this project at the commit or tag the binary was built from. Set it when you deploy a version you changed -- see [License]({{ site.baseurl }}{% link license.md %}) |
| `HISTORY_DB` | unset | Path of a SQLite file; every message is also written there, and the UI can load time ranges from it (`from`/`to` on the history endpoints, the range picker in the subject detail). Set, it is always on and the UI cannot change it; unset, a `STORAGE_DIR` server offers `<STORAGE_DIR>/history.db` as a setting (off until switched on) |
| `HISTORY_RETENTION` | `72h` | Rows older than this are deleted once a minute (Go duration, e.g. `24h`, `168h`). Without `HISTORY_DB` it is the starting value of the setting, which then wins once changed |
| `HISTORY_FTS` | `1` | `0` drops the full-text index of the persistent history: the writer becomes several times faster and a search scans instead of using the index. Also a setting in the UI |
| `HISTORY_FILTER` | – | A CEL expression over the same variables as a payload filter; only messages it accepts are written to disk. The one setting that lowers the write rate itself instead of making the writer faster. Also a setting in the UI |
| `HISTORY_QUEUE_BYTES` | `67108864` | How much of a burst the writer buffers before it drops from the disk copy. Also a setting in the UI |
| `ROLLUP_RETENTION` | `2160h` | With a persistent history: how long the minute aggregates behind long-range charts are kept (90 days by default; they are far smaller than the messages) |
| `HISTORY_MB` | `256` | Memory budget for the recorded message history the UI pulls from (all connections together; the process gets a soft memory limit of twice that plus 128 MB) |

### Accounts and roles

```bash
./nats-explorer hash-password            # prompts, prints a bcrypt hash
printf 'alice:admin:%s\nbob:viewer:%s\n' "$ADMIN_HASH" "$VIEWER_HASH" > users.txt
AUTH_USERS=users.txt ./nats-explorer
```

Admins may publish, create, edit and delete; viewers get a read-only explorer (writes answer `403`). Scripts and Prometheus can authenticate with HTTP basic auth or, with `AUTH_TOKEN`, a bearer token; browsers use the session cookie set by `POST /api/login`. Sessions live in memory and end with a restart.

### Metrics

`GET /metrics` exposes the explorer's own counters in the Prometheus text format: messages received, throttled and per-second rate per connection, distinct subjects, history size in memory and on disk, websocket clients and connection states. It is protected like the API.

---

## Verify

Open `http://localhost:3002` (or start the desktop app). Add a connection with your server URL, for example `nats://localhost:4222`, and click *Connect*. The Subjects module fills as soon as messages flow.
