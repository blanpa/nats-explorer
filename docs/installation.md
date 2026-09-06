---
layout: default
title: Installation
nav_order: 2
---

# Installation

NATS Explorer runs as a desktop application, as a Docker container, or as a standalone server binary. All downloads are on the [Releases page](https://github.com/blanpa/nats-explorer/releases) together with a `SHA256SUMS.txt`.

---

## Desktop app

| Platform | File | Notes |
|:-- |:-- |:-- |
| Windows 10/11 | `nats-explorer-desktop-<version>-windows-x64-setup.exe` | Per-user installer, no admin rights, Start-menu entry and uninstaller. `…-windows-x64.zip` is the portable variant. Uses the Edge WebView2 runtime (downloaded on first start if missing). Not code-signed: SmartScreen shows "unknown publisher", choose *More info → Run anyway*. |
| macOS 11+ | `nats-explorer-desktop-<version>-macos-universal.dmg` | Intel and Apple Silicon. Drag to *Applications*. Not notarized: right-click → *Open* on first start, or `xattr -dr com.apple.quarantine "/Applications/NATS Explorer.app"`. |
| Linux | `…-linux-x64.AppImage`, `…-linux-x64.deb`, `…-linux-x64.tar.gz` | AppImage: `chmod +x` and run. Debian/Ubuntu: `sudo apt install ./nats-explorer-desktop-<version>-linux-x64.deb`. Needs webkit2gtk 4.1 (Ubuntu 22.04+, Debian 12+, Fedora 37+). |

### Where the desktop app keeps its data

| | Location |
|:-- |:-- |
| Linux | `~/.config/nats-explorer/` |
| Windows | `%AppData%\nats-explorer\` |
| macOS | `~/Library/Application Support/nats-explorer/` |

`settings.json` holds connections, request templates and preferences. Credentials (tokens, passwords, NKey seeds, credentials files, TLS keys) go to the system keyring (Secret Service, Keychain, Credential Manager); where none is available they are written to `secrets.json`, readable only by your user. Back up the directory to keep your setup; delete it to start fresh.

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

Download `nats-explorer-server-<version>-<os>-<arch>` for linux-x64, linux-arm64, windows-x64, macos-x64 or macos-arm64. The UI is bundled as `public/` next to the binary and found automatically.

```bash
tar xzf nats-explorer-server-0.2.0-linux-x64.tar.gz
cd nats-explorer-server-0.2.0-linux-x64
./nats-explorer
# Windows: extract the zip and run nats-explorer.exe
```

---

## Configuration

| Variable | Default | Description |
|:-- |:-- |:-- |
| `PORT` | `3002` | HTTP port of the web UI and API |
| `PUBLIC_PATH` | auto | UI files; defaults to `public/` next to the binary or `client/dist` in a checkout |
| `AUTH_TOKEN` | unset | When set, every API and websocket call needs this token (entered once in the UI) |
| `STORAGE_DIR` | unset | Keep connections, templates and preferences in this directory instead of the browser (single-user servers). Same layout as the desktop app |
| `NO_KEYRING` | unset | With `STORAGE_DIR`: always use `secrets.json` instead of the system keyring |

---

## Verify

Open `http://localhost:3002` (or start the desktop app). Add a connection with your server URL, for example `nats://localhost:4222`, and click *Connect*. The Subjects module fills as soon as messages flow.
