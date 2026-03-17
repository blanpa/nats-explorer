---
layout: default
title: Home
nav_order: 1
---

# NATS Explorer

A web-based NATS management tool and message explorer inspired by [MQTT Explorer](https://mqtt-explorer.com/). Browse subjects as a live tree, manage JetStream streams, Key-Value stores, Object Stores, and monitor server health -- all from a single dark-themed UI.

---

## Highlights

- **Zero dependencies** -- single binary, no runtime needed
- **Cross-platform** -- Linux, Windows, macOS (x64 + ARM64)
- **Real-time** -- WebSocket-based live updates with message batching
- **Multi-connection** -- connect to multiple NATS servers simultaneously
- **Full JetStream support** -- streams, consumers, KV, object stores
- **Dark theme** -- designed for long monitoring sessions

---

## Get Started

The fastest way to try NATS Explorer:

```bash
docker compose up -d
# Open http://localhost:3002
```

Or download a standalone binary from the [Releases page](https://github.com/blanpa/nats-explorer/releases).

See the [Installation Guide]({% link installation.md %}) for all options.

---

## Screenshots

> The UI is a three-panel layout:
>
> - **Left sidebar** -- Navigation (Subjects, JetStream, KV, Object Store, Services, Monitoring) plus connection panel
> - **Center panel** -- Subject tree with expandable hierarchy, inline values and rate indicators
> - **Right panel** -- Message detail with formatted JSON, headers, and live value charts
