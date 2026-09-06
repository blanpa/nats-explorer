# NATS Explorer

A NATS management tool and message explorer inspired by MQTT Explorer, available as a desktop app for Windows, macOS and Linux and as a web UI served by a single Go binary or Docker image. Browse subjects as a live tree, manage JetStream streams, Key-Value and Object Stores, run and repeat requests, and watch servers, clusters and leaf nodes -- with dark and light themes.

See the [changelog](CHANGELOG.md) for what changed in each release.

![Subject explorer](docs/screenshots/subjects-dark.png)

<details>
<summary>More screenshots</summary>

![JetStream, light theme](docs/screenshots/jetstream-light.png)
![Monitoring](docs/screenshots/monitoring-dark.png)
![Connections](docs/screenshots/connections-dark.png)

</details>

![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)
![Go](https://img.shields.io/badge/go-1.26%2B-00ADD8.svg)
![NATS](https://img.shields.io/badge/NATS-2.10%2B-purple.svg)

---

## Install

Every release on the [Releases page](https://github.com/blanpa/nats-explorer/releases) ships the desktop app for all three platforms plus headless server builds and a Docker image.

| Platform | File | Notes |
|---|---|---|
| Windows 10/11 | `nats-explorer-desktop-<version>-windows-x64-setup.exe` | Per-user installer, no admin rights needed; creates Start-menu entry and uninstaller. `…-windows-x64.zip` is the portable variant. Uses the Edge WebView2 runtime (present on Windows 11; downloaded on first start otherwise). The installer is not code-signed: SmartScreen shows "unknown publisher", choose *More info → Run anyway*. |
| macOS 11+ (Intel and Apple Silicon) | `nats-explorer-desktop-<version>-macos-universal.dmg` | Drag *NATS Explorer* to *Applications*. The app is not notarized: on first start right-click → *Open*, or run `xattr -dr com.apple.quarantine "/Applications/NATS Explorer.app"`. |
| Linux | `…-linux-x64.AppImage`, `…-linux-x64.deb`, `…-linux-x64.tar.gz` | AppImage: `chmod +x` and run. Debian/Ubuntu: `sudo apt install ./nats-explorer-desktop-<version>-linux-x64.deb` (pulls `libwebkit2gtk-4.1-0`). |
| Server / headless | `nats-explorer-server-<version>-<os>-<arch>.tar.gz` / `.zip` | Run the binary; it serves the UI on http://localhost:3002. Env: `PORT`, `PUBLIC_PATH`, `AUTH_TOKEN`. |
| Docker | `ghcr.io/blanpa/nats-explorer:<version>` | `docker run -p 3002:3002 ghcr.io/blanpa/nats-explorer:latest` |

The desktop app is the same Go backend plus the UI in a native window (Wails, system webview). Connections, request templates and preferences are stored in `settings.json` under the OS config directory (`~/.config/nats-explorer`, `%AppData%\nats-explorer`, `~/Library/Application Support/nats-explorer`); credentials go to the system keyring (Secret Service, Keychain, Credential Manager) or, where none is available, to a `secrets.json` readable only by your user. Back up that directory to keep your setup. The same file storage can be enabled for a personal server with `STORAGE_DIR=/path` (`NO_KEYRING=1` forces the file fallback).

### Building the installers yourself

```bash
pnpm install && pnpm --filter shared build && pnpm --filter client build
scripts/build-desktop.sh --docker linux     # AppImage, .deb, tar.gz  (uses scripts/desktop-builder.Dockerfile)
scripts/build-desktop.sh --docker windows   # NSIS installer + portable zip, cross-compiled
scripts/build-desktop.sh macos              # on a Mac: universal .app + .dmg (needs the Wails CLI)
scripts/smoke-desktop.sh go-server/build/bin/nats-explorer   # launches the build headless and checks API, UI and websocket
```

Releases are produced by `.github/workflows/release.yml` on every `v*` tag: the UI is built once, each OS job builds and smoke-tests its package (silent install/uninstall on Windows), and everything is attached to the GitHub release with a `SHA256SUMS.txt`.

## Features

- **Subject Tree** -- Virtualized live tree of dot-separated subjects with inline values, rates, keyboard navigation and filtering
- **Message Detail** -- JSON/raw/hex views, history, diff to the previous message, charts for numeric fields
- **JetStream** -- Create, edit, purge and delete streams; page through messages from the newest sequence; live tail; manage consumers
- **Key-Value** -- Browse buckets, edit keys, purge, full revision history, live updates via server-side watch
- **Object Store** -- Drag & drop upload, download, delete objects and stores
- **Services** -- Discover NATS micro services ($SRV.INFO / STATS / PING)
- **Publish / Request-Reply** -- Send messages with headers, perform request-reply with timeout
- **Multi-Connection** -- Connect to multiple NATS servers simultaneously
- **Authentication** -- Token, username/password, NKey, JWT/credentials, TLS
- **Live Value Charts** -- Chart any numeric JSON field over time as line, area, step, bars or dots
- **JetStream domains** -- a connection can target a JetStream domain or API prefix (leaf nodes behind a hub and vice versa), and the JetStream, KV and Object Store panes can switch domains ad hoc
- **Requests module** -- Postman-style request templates in the sidebar: create, edit, duplicate, run, import/export as JSON. Repeat a request up to 10 000× with parallel senders and `{{i}}`/`{{ts}}`/`{{uuid}}`/`{{rand:1-100}}` variables and read throughput and latency percentiles. The publish drawer under a subject uses the same templates
- **TLS with certificates** -- CA certificate, client certificate and key can be pasted or loaded from files per connection (mutual TLS), plus an insecure mode for test setups
- **Cluster module** -- every node of the cluster with version, uptime, CPU, memory, connections and JetStream usage, the JetStream meta cluster (leader, peers, lag, offline) and the placement of every stream with its leader and replicas. Needs system-account (`$SYS`) credentials on the connection; without them the module shows the connected node only
- **Monitoring with history** -- messages/s and bytes/s in and out, connections, subscriptions, CPU and JetStream API rates over time, cluster routes and leaf nodes with their traffic
- **Themes** -- Dark and light, follows the OS preference on first start

---

## Quick Start

### Docker (recommended)

```bash
docker compose up -d
```

Starts NATS (port 4222) and NATS Explorer (port 3002). Open `http://localhost:3002`.

### Standalone Binary

Download a `nats-explorer-server-<version>-<os>-<arch>` archive from [Releases](https://github.com/blanpa/nats-explorer/releases); the UI is bundled as `public/` next to the binary and found automatically:

```bash
# Linux / macOS
tar xzf nats-explorer-server-0.2.0-linux-x64.tar.gz
cd nats-explorer-server-0.2.0-linux-x64
./nats-explorer

# Windows: extract nats-explorer-server-0.2.0-windows-x64.zip, then run nats-explorer.exe
```

Open `http://localhost:3002` and configure your NATS server in the connection dialog. `STORAGE_DIR=/path` keeps connections and templates on the server instead of in the browser (single-user setups).

### Docker (standalone, no NATS included)

```bash
docker compose -f docker-compose.standalone.yml up -d
```

---

## Development

### Prerequisites

- **Go** 1.24+
- **Node.js** 20+ with **pnpm** (`corepack enable`)
- **Docker** (for the dev NATS server)

### Setup

```bash
pnpm install

# Start dev NATS server with sample data
pnpm nats:dev

# Start Go backend + Vite frontend (hot reload)
pnpm dev
```

The Go server runs on `http://localhost:3002`, the Vite dev server on `http://localhost:5173`.

### Tests

```bash
pnpm --filter client test          # vitest unit tests
cd go-server && go test -race ./... # Go unit + end-to-end tests (embedded nats-server)
pnpm nats:dev                      # dev NATS on :4230 with seed data, then:
pnpm --filter e2e exec playwright install chromium
pnpm test:e2e                      # Playwright smoke suite against http://localhost:3002
```

The e2e suite honours `NE_URL`, `NATS_URL`, `NATS_MON_URL` and `PW_CHROME=/path/to/chrome`.

---

## Tech Stack

| Layer   | Technology                                                   |
| ------- | ------------------------------------------------------------ |
| Backend | Go 1.26, chi router, gorilla/websocket, nats.go             |
| Client  | React 18, TypeScript, Vite, Tailwind CSS, Zustand, Radix UI |
| Shared  | TypeScript types (workspace package)                         |
| Build   | Docker multi-stage, Go cross-compilation                     |
| Deploy  | Docker, standalone binaries (no runtime dependencies)        |

---

## Architecture

```
                        +-------------------+
                        |   NATS Server(s)  |
                        |   (port 4222)     |
                        +--------+----------+
                                 | TCP (nats.go)
                                 |
+------------------+    +--------+----------+
|   Browser        | WS |   Go Server       |
|   (React SPA)    +----+   (port 3002)     |
|                  | HTTP|                   |
|   - Subject Tree +----+ - Connection Store|
|   - JetStream    |    | - Subscription Mgr|
|   - KV / ObjStore|    | - Subject Tree    |
|   - Monitoring   |    | - chi Router      |
|   - Services     |    | - WebSocket Hub   |
+------------------+    +-------------------+
```

---

## Building

### Desktop installers

See [Building the installers yourself](#building-the-installers-yourself) above (`scripts/build-desktop.sh`).

### Cross-compile the server for all platforms

```bash
node build.mjs
# Output: release/nats-explorer-{linux-x64,linux-arm64,windows-x64,macos-x64,macos-arm64}/
```

### Docker image

```bash
docker build -f go-server/Dockerfile -t nats-explorer .
```

### Single platform (portable)

```bash
node build-portable.mjs
# Output: release/portable/ (binary + public/ + start scripts)
```

---

## Security

The backend has no authentication and holds NATS credentials in memory; saved connections (including tokens and passwords) live unencrypted in the browser's local storage. Bind the port to localhost or a trusted network only.

See [docs/review-2026-09.md](docs/review-2026-09.md) for the findings of the September 2026 code review and redesign.

---

## Configuration

| Variable      | Default | Description                      |
| ------------- | ------- | -------------------------------- |
| `PORT`        | `3002`  | HTTP server port                 |
| `PUBLIC_PATH` | --      | Path to client static files      |
| `AUTH_TOKEN`  | --      | When set, every API and websocket request must carry the token (`Authorization: Bearer`, `X-Auth-Token` or `?token=`). The UI asks for it once per tab. |

---

## Project Structure

```
nats-explorer/
  go-server/                  # Go backend
    main.go                   # Server entry point (desktop.go: Wails window, build tag `desktop`)
    server.go                 # Router wiring
    build/                    # Desktop packaging assets (icon, Info.plist, NSIS script, desktop entry)
    internal/
      connection/store.go     # Multi-connection NATS store (main + system-account connections)
      handler/                # HTTP handlers (one per feature: streams, kv, run, cluster, settings …)
      settings/               # File-backed UI settings + keyring secrets
      subscription/           # Message subscription, budgets & subject tree feed
      ws/hub.go               # WebSocket connection hub
  client/                     # React frontend (Vite)
    src/
      components/             # Feature-organized UI components (subjects, jetstream, kv, objectstore, services, requests, monitoring, cluster)
      lib/                    # API client, WebSocket, storage sync, utilities
      store/                  # Zustand state management
  shared/                     # Shared TypeScript type definitions
  e2e/                        # Playwright smoke suite
  scripts/                    # Desktop build, builder image, smoke tests
  dev/                        # Dev NATS server and simulators
  docs/                       # Architecture notes, review log, screenshots
  .github/workflows/          # CI + Release pipelines
```

---

## Release Targets

Releases are built automatically on tag push (`v*`); a manual `workflow_dispatch` run produces the same artifacts without publishing.

| Target | Files |
| --- | --- |
| Windows desktop | `…-windows-x64-setup.exe` (per-user installer), `…-windows-x64.zip` (portable) |
| macOS desktop | `…-macos-universal.dmg`, `.zip` (Intel + Apple Silicon) |
| Linux desktop | `…-linux-x64.AppImage`, `.deb`, `.tar.gz` |
| Server (headless) | `nats-explorer-server-<version>-{linux-x64,linux-arm64,windows-x64,macos-x64,macos-arm64}` |
| Docker (GHCR) | `ghcr.io/blanpa/nats-explorer:<version>` |

Every release carries a `SHA256SUMS.txt`. Installers are not code-signed (see the notes in [Install](#install)).

---

## License

[Apache License 2.0](LICENSE) -- Copyright 2026 blanpa
