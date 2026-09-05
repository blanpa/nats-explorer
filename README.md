# NATS Explorer

A web-based NATS management tool and message explorer inspired by MQTT Explorer. Browse subjects as a live tree, manage JetStream streams, Key-Value stores, Object Stores, and monitor server health -- from one UI with dark and light themes.

![Subject explorer](docs/screenshots/subjects-dark.png)

<details>
<summary>More screenshots</summary>

![JetStream, light theme](docs/screenshots/jetstream-light.png)
![Monitoring](docs/screenshots/monitoring-dark.png)
![Connections](docs/screenshots/connections-dark.png)

</details>

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Go](https://img.shields.io/badge/go-1.24%2B-00ADD8.svg)
![NATS](https://img.shields.io/badge/NATS-2.10%2B-purple.svg)

---

## Features

- **Subject Tree** -- Virtualized live tree of dot-separated subjects with inline values, rates, keyboard navigation and filtering
- **Message Detail** -- JSON/raw/hex views, history, diff to the previous message, charts for numeric fields
- **JetStream** -- Create, edit, purge and delete streams; page through messages from the newest sequence; live tail; manage consumers
- **Key-Value** -- Browse buckets, edit keys, purge, full revision history, live updates via server-side watch
- **Object Store** -- Drag & drop upload, download, delete objects and stores
- **Services** -- Discover NATS micro services ($SRV.INFO / STATS / PING)
- **Monitoring** -- Server health dashboard (varz, connz, jsz, routez, etc.)
- **Cluster Info** -- View connected server details and topology
- **Publish / Request-Reply** -- Send messages with headers, perform request-reply with timeout
- **Multi-Connection** -- Connect to multiple NATS servers simultaneously
- **Authentication** -- Token, username/password, NKey, JWT/credentials, TLS
- **Live Value Charts** -- Chart any numeric JSON field over time
- **Themes** -- Dark and light, follows the OS preference on first start

---

## Quick Start

### Docker (recommended)

```bash
docker compose up -d
```

Starts NATS (port 4222) and NATS Explorer (port 3002). Open `http://localhost:3002`.

### Standalone Binary

Download from [Releases](https://github.com/blanpa/nats-explorer/releases):

```bash
# Linux / macOS
tar xzf nats-explorer-linux-x64.tar.gz
cd nats-explorer-linux-x64
PUBLIC_PATH=./public ./nats-explorer

# Windows
# Extract nats-explorer-windows-x64.zip, then:
set PUBLIC_PATH=.\public
nats-explorer.exe
```

Open `http://localhost:3002` and configure your NATS server in the connection dialog.

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
| Backend | Go 1.24, chi router, gorilla/websocket, nats.go             |
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

### Cross-compile all platforms

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
    main.go                   # Entry point, router wiring
    internal/
      connection/store.go     # Multi-connection NATS store
      handler/                # HTTP handlers (one per feature)
      subscription/           # Message subscription & subject tree
      ws/hub.go               # WebSocket connection hub
  client/                     # React frontend (Vite)
    src/
      components/             # Feature-organized UI components
      lib/                    # API client, WebSocket, utilities
      store/                  # Zustand state management
  shared/                     # Shared TypeScript type definitions
  dev/                        # Dev NATS server and simulators
  .github/workflows/          # CI + Release pipelines
```

---

## Release Targets

Releases are built automatically on tag push (`v*`):

| Target                  | Description           |
| ----------------------- | --------------------- |
| `linux-x64`             | Linux x86_64          |
| `linux-arm64`           | Linux ARM64           |
| `windows-x64`           | Windows x86_64 (.exe) |
| `macos-x64`             | macOS Intel           |
| `macos-arm64`           | macOS Apple Silicon   |
| Docker (GHCR)           | Multi-stage Alpine    |

---

## License

[MIT](LICENSE) -- Copyright (c) 2026 blanpa
