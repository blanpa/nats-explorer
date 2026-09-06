---
layout: default
title: Home
nav_order: 1
---

# NATS Explorer

A NATS management tool and message explorer inspired by [MQTT Explorer](https://mqtt-explorer.com/). It ships as a desktop app for Windows, macOS and Linux and as a web UI served by a single Go binary or Docker image. Browse subjects as a live tree, manage JetStream streams, Key-Value and Object Stores, run and repeat requests, and watch servers, clusters and leaf nodes.

---

## Highlights

- **Desktop app** -- installers for Windows, macOS and Linux; settings kept in the OS config directory, credentials in the system keyring
- **Single binary or Docker** -- the same backend serves the web UI for teams
- **Live subject tree** -- virtualized, filterable, with inline values and rates; tuned for tens of thousands of subjects
- **Full JetStream support** -- streams, consumers, KV, object stores, JetStream domains for hub/leaf setups
- **Requests** -- saved request templates, request/reply, repeated runs with latency percentiles
- **Cluster and monitoring** -- every node, meta cluster and stream placement via the system account; throughput history charts
- **Multi-connection** -- several NATS servers at once, with token, user/password, NKey, credentials and mutual TLS
- **Dark and light theme**

---

## Get Started

Desktop: download the installer for your platform from the [Releases page](https://github.com/blanpa/nats-explorer/releases).

Web UI:

```bash
docker compose up -d
# Open http://localhost:3002
```

See the [Installation Guide]({% link installation.md %}) for all options and the [changelog](https://github.com/blanpa/nats-explorer/blob/main/CHANGELOG.md) for what changed per release.

---

## Layout

- **Rail** -- modules: Subjects, JetStream, Key-Value, Object Store, Services, Requests, Monitoring, Cluster
- **Explorer pane** -- the tree or list of the current module (subjects, streams, buckets, stores, services, request templates)
- **Detail pane** -- message detail with JSON/raw/hex views, history, diff and charts; stream, bucket, store, service and request editors; dashboards
