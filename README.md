# NATS Explorer

A web-based NATS management tool and message explorer inspired by MQTT Explorer. Browse subjects as a live tree, manage JetStream streams, Key-Value stores, Object Stores, and monitor server health -- all from a single dark-themed UI.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Go](https://img.shields.io/badge/go-1.24%2B-00ADD8.svg)
![NATS](https://img.shields.io/badge/NATS-2.10%2B-purple.svg)

---

## Features

- **Subject Tree** -- Hierarchical live view of dot-separated NATS subjects with inline values and message rates
- **JetStream** -- Create, update, delete streams; browse messages by sequence; manage consumers
- **Key-Value** -- Browse buckets, view/edit keys, full revision history
- **Object Store** -- Upload, download, and manage objects
- **Services** -- Discover NATS micro services ($SRV.INFO / STATS / PING)
- **Monitoring** -- Server health dashboard (varz, connz, jsz, routez, etc.)
- **Cluster Info** -- View connected server details and topology
- **Publish / Request-Reply** -- Send messages with headers, perform request-reply with timeout
- **Multi-Connection** -- Connect to multiple NATS servers simultaneously
- **Authentication** -- Token, username/password, NKey, JWT/credentials, TLS
- **Live Value Charts** -- Auto-chart numeric JSON fields over time

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

## Configuration

| Variable      | Default | Description                      |
| ------------- | ------- | -------------------------------- |
| `PORT`        | `3002`  | HTTP server port                 |
| `PUBLIC_PATH` | --      | Path to client static files      |

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
