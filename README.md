# NATS Explorer

A web-based NATS management tool and message explorer inspired by MQTT Explorer. Browse subjects as a live tree, manage JetStream streams, Key-Value stores, Object Stores, and monitor server health -- all from a single dark-themed UI.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-20%2B-green.svg)
![NATS](https://img.shields.io/badge/NATS-2.10%2B-purple.svg)

---

## Screenshot

> **Placeholder** -- The UI is a three-panel layout:
>
> - **Left sidebar** -- Navigation tabs (Subjects, JetStream, KV, Object Store, Services, Monitoring) plus the connection panel.
> - **Center panel** -- Subject tree with expandable dot-separated hierarchy. Each node shows the latest value inline and a message rate indicator.
> - **Right panel** -- Message detail view with formatted JSON, raw text, headers, and a live value chart for numeric fields.
>
> The color scheme follows a dark theme with accent colors for status indicators.

---

## Features

### Subject Tree Browsing
- Hierarchical view of dot-separated NATS subjects (MQTT Explorer style)
- Inline display of the latest value for each subject
- Live message count and rate per node
- Virtual tree rendering for high-throughput scenarios

### Multi-Connection Support
- Connect to multiple NATS servers simultaneously
- Switch between active connections
- Saved connection profiles

### JetStream Management
- List, create, update, and delete streams
- Browse stream messages with sequence navigation
- List and manage consumers
- View stream configuration and state

### Key-Value Store Browser
- Browse KV buckets and their keys
- View current values with formatted JSON display
- Key history with revisions
- Create and delete keys

### Object Store Browser
- Browse Object Store buckets and objects
- Upload and download files
- Delete objects
- View object metadata (size, chunks, digest)

### Services Discovery
- Discover services registered via the NATS micro framework
- View service info, stats, and endpoints

### Server Monitoring Dashboard
- Server health and version info (varz)
- Connection statistics (connz)
- JetStream account info and usage
- Route and gateway information

### Cluster Visualization
- View cluster topology and connected nodes

### Live Value Charts
- Automatic charting of numeric JSON fields over time
- Select any numeric field from the message payload to chart

### Request / Reply
- Send request messages and view replies
- Configurable timeout

### Message Publishing
- Publish messages to any subject
- Custom headers support
- JSON and plain text payloads

### Configurable Subscriptions
- Configure root topics to subscribe to
- System topic support: `$SYS`, `$JS`, `$KV`, `$SRV`

### Authentication
- Token authentication
- Username / Password
- NKey
- JWT / Credentials file
- TLS certificates

### Dark Theme
- MQTT Explorer inspired dark UI
- Designed for long monitoring sessions

### Performance Optimized
- Message throttling and batching on the server
- Virtual tree rendering (TanStack Virtual) for large subject trees
- WebSocket-based real-time updates

---

## Tech Stack

| Layer    | Technology                                                     |
| -------- | -------------------------------------------------------------- |
| Client   | React 18, TypeScript, Vite, Tailwind CSS, Zustand, Radix UI   |
| Server   | Node.js, Express, WebSocket (ws), nats.js, Zod                |
| Shared   | TypeScript types (workspace package)                           |
| Build    | pnpm workspaces, esbuild, @yao-pkg/pkg                        |
| Deploy   | Docker, standalone executables                                 |

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/your-org/nats-explorer.git
cd nats-explorer

# Install dependencies
pnpm install

# Start development servers (client + server)
pnpm dev
```

The Express server runs on `http://localhost:3002` and the Vite dev server on `http://localhost:5173`. The client proxies API requests to the server.

---

## Installation Options

### Development Mode

```bash
pnpm install
pnpm dev
```

Starts both the Express backend (port 3002) and Vite dev server (port 5173) with hot reload.

### Docker

Run NATS Explorer alongside a NATS server:

```bash
docker compose up -d
```

This starts both a NATS server (port 4222, monitoring on 8222) and NATS Explorer (port 3002).

To run NATS Explorer standalone (connect to an external NATS server):

```bash
docker compose -f docker-compose.standalone.yml up -d
```

Then open `http://localhost:3002` and configure your NATS server address in the connection dialog.

### Portable Build (Node.js required)

Creates a single bundled `server.cjs` file with startup scripts. Requires Node.js 20+ on the target machine.

```bash
pnpm build:portable
```

Output is placed in `release/portable/`:

```
release/portable/
  server.cjs      # Bundled server (single file)
  public/         # Web UI static files
  start.sh        # Linux / macOS launcher
  start.bat       # Windows launcher (CMD)
  start.ps1       # Windows launcher (PowerShell)
```

Usage:

```bash
./start.sh              # Linux / macOS
start.bat               # Windows CMD
.\start.ps1             # Windows PowerShell
```

### Standalone Executables

Creates self-contained executables for Linux and Windows. No Node.js required on the target machine.

```bash
pnpm build:exe
```

Output is placed in `release/`:

```
release/
  nats-explorer-linux-x64/
    nats-explorer         # Linux binary
    public/               # Web UI files (must stay alongside the binary)
  nats-explorer-win-x64/
    nats-explorer.exe     # Windows executable
    public/               # Web UI files
```

Usage:

```bash
./nats-explorer           # Linux
nats-explorer.exe         # Windows
# Open http://localhost:3002
```

---

## Dev NATS Server

The `dev/` directory provides a self-contained development environment with a NATS server and a UNS (Unified Namespace) simulator that publishes realistic factory data.

```bash
# Start the dev NATS server (port 4230, monitoring on 8230)
pnpm nats:start

# Seed JetStream streams, KV buckets, and Object Store data
pnpm nats:seed

# Start the UNS simulator (publishes factory telemetry every second)
pnpm nats:simulate

# Or do all three at once
pnpm nats:dev

# Stop the dev NATS server
pnpm nats:stop
```

The simulator publishes data on an ISA-95 style topic hierarchy:

```
uns.acme.factory-berlin.assembly.line-1.robot-01.position
uns.acme.factory-berlin.machining.line-2.cnc-01.spindle
uns.acme.factory-berlin.energy.main-meter.power
events.alarm.line-2.cnc-01
metrics.oee.line-1
...
```

Connect to `nats://localhost:4230` in the NATS Explorer connection dialog to browse the simulated data.

---

## Architecture

```
                          +-------------------+
                          |   NATS Server(s)  |
                          |   (port 4222)     |
                          +--------+----------+
                                   | TCP (nats.js)
                                   |
+------------------+      +--------+----------+
|   Browser        | HTTP |   Express Server  |
|   (React SPA)    +------+   (port 3002)     |
|                  |  WS  |                   |
|   - Subject Tree +------+ - Connection Mgr  |
|   - JetStream    |      | - Subscription Mgr|
|   - KV / ObjStore|      | - Subject Tree    |
|   - Monitoring   |      | - REST API Routes |
|   - Services     |      | - WebSocket Handler|
+------------------+      +-------------------+
```

- The **server** maintains NATS connections and manages subscriptions. It builds a subject tree in memory, batches updates, and pushes them to connected browsers over WebSocket.
- The **client** is a React SPA that communicates with the server via REST (for CRUD operations) and WebSocket (for real-time subject tree updates and messages).
- **Shared types** ensure type safety across the client-server boundary.

---

## Project Structure

```
nats-explorer/
  client/                     # React frontend (Vite)
    src/
      components/
        cluster/              # Cluster visualization
        connection/           # Connection dialog and panel
        jetstream/            # Stream and consumer management
        kv/                   # Key-Value store browser
        layout/               # Header, Sidebar, StatusBar, MainContent
        messages/             # Message list, detail, payload viewer, value chart
        monitoring/           # Server monitoring dashboard
        objectstore/          # Object Store browser
        publish/              # Publish panel
        services/             # Services discovery
        subjects/             # Subject tree and node components
      lib/                    # API client, WebSocket client, utilities
      store/                  # Zustand state management
  server/                     # Express backend
    src/
      nats/                   # Connection manager, subscription manager, subject tree
      routes/                 # REST API routes (one file per feature)
      ws/                     # WebSocket handler
  shared/                     # Shared TypeScript types
    src/
      connection.ts           # Connection types
      jetstream.ts            # JetStream types
      kv.ts                   # Key-Value types
      messages.ts             # Message types
      objectstore.ts          # Object Store types
      ws-events.ts            # WebSocket event types
  dev/                        # Development NATS server and simulators
    docker-compose.yml        # Dev NATS server (port 4230)
    seed.mjs                  # Seeds streams, KV buckets, object stores
    simulate.mjs              # UNS factory data simulator
  build.mjs                   # Standalone executable build script
  build-portable.mjs          # Portable build script
  docker-compose.yml          # Production Docker Compose (NATS + Explorer)
  docker-compose.standalone.yml  # Explorer only (bring your own NATS)
  Dockerfile                  # Multi-stage Docker build
  pnpm-workspace.yaml         # Workspace configuration
```

---

## Configuration

### Environment Variables

| Variable         | Default | Description                                     |
| ---------------- | ------- | ----------------------------------------------- |
| `PORT`           | `3002`  | HTTP server port                                |
| `NODE_ENV`       | --      | Set to `production` to serve static client files|
| `__PUBLIC_PATH`  | --      | Override path to client static files            |

### Ports

| Service              | Port  | Description                        |
| -------------------- | ----- | ---------------------------------- |
| Express server       | 3002  | REST API + WebSocket + static files|
| Vite dev server      | 5173  | Client dev server (development)    |
| Dev NATS server      | 4230  | NATS protocol (dev environment)    |
| Dev NATS monitoring  | 8230  | NATS HTTP monitoring (dev)         |

---

## Building

```bash
# Build all packages (shared, server, client)
pnpm build

# Build portable distribution (requires Node.js on target)
pnpm build:portable

# Build standalone executables (no Node.js required on target)
pnpm build:exe

# Build Docker image
pnpm docker:build

# Start with Docker Compose
pnpm docker:up

# Stop Docker Compose
pnpm docker:down
```

---

## License

[MIT](LICENSE) -- Copyright (c) 2026 blanpa
