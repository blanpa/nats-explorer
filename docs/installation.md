---
layout: default
title: Installation
nav_order: 2
---

# Installation

NATS Explorer can be run as a Docker container, a standalone binary, or from source.

---

## Docker (recommended)

### With NATS server included

```bash
docker compose up -d
```

This starts both a NATS server (port 4222, monitoring on 8222) and NATS Explorer (port 3002).

### Standalone (bring your own NATS)

```bash
docker compose -f docker-compose.standalone.yml up -d
```

Open `http://localhost:3002` and configure your NATS server address in the connection dialog.

### Custom Docker run

```bash
docker run -d -p 3002:3002 ghcr.io/blanpa/nats-explorer:latest
```

---

## Standalone Binary

Download the latest release for your platform from [GitHub Releases](https://github.com/blanpa/nats-explorer/releases).

### Linux

```bash
tar xzf nats-explorer-linux-x64.tar.gz
cd nats-explorer-linux-x64
PUBLIC_PATH=./public ./nats-explorer
```

### macOS

```bash
tar xzf nats-explorer-macos-arm64.tar.gz  # or macos-x64
cd nats-explorer-macos-arm64
PUBLIC_PATH=./public ./nats-explorer
```

### Windows

1. Extract `nats-explorer-windows-x64.zip`
2. Open a terminal in the extracted folder
3. Run:

```cmd
set PUBLIC_PATH=.\public
nats-explorer.exe
```

Open `http://localhost:3002` in your browser.

---

## Configuration

| Variable      | Default | Description                          |
|:------------- |:------- |:------------------------------------ |
| `PORT`        | `3002`  | HTTP server port                     |
| `PUBLIC_PATH` | auto    | Path to the `public/` UI files       |

Example with custom port:

```bash
PORT=8080 PUBLIC_PATH=./public ./nats-explorer
```

---

## Verify Installation

After starting, open `http://localhost:3002`. You should see the NATS Explorer UI with a connection dialog. Enter your NATS server address (e.g., `nats://localhost:4222`) and click Connect.
