---
layout: default
title: Home
nav_order: 1
---

<img src="{{ '/assets/images/logo.png' | relative_url }}" alt="" width="88" height="88">

# NATS Explorer
{: .fs-9 .no_toc }

A NATS management tool and message explorer -- as a desktop app for Windows, macOS
and Linux, or as a web UI served by a single Go binary.
{: .fs-6 .fw-300 }

[Install]({% link installation.md %}){: .btn .btn-primary .mr-2 }
[Features]({% link features.md %}){: .btn .mr-2 }
[GitHub](https://github.com/blanpa/nats-explorer){: .btn }

---

![The subject tree with a message and its value chart]({{ '/screenshots/subjects-dark.png' | relative_url }})

Browse subjects as a live tree, manage JetStream streams, Key-Value and Object
Stores, run and repeat requests, watch servers, clusters and leaf nodes -- and
keep the messages after the tab is closed. Inspired by
[MQTT Explorer](https://mqtt-explorer.com/), built for NATS.

---

## Download

| | |
|:--|:--|
| **Windows** | [Installer (.exe)](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-windows-x64-setup.exe) -- per-user, no admin rights |
| **macOS** | [Disk image (.dmg)](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-macos-universal.dmg) -- Intel and Apple Silicon |
| **Linux** | [AppImage](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-linux-x64.AppImage) &middot; [.deb](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-linux-x64.deb) |
| **Server** | Docker image, or the standalone binary -- see [Installation]({% link installation.md %}) |

These links always hand out the newest build. Every package with its version in
the name, plus `SHA256SUMS.txt` over all of them, is on the
[Releases page](https://github.com/blanpa/nats-explorer/releases).

The web UI in one command:

```bash
docker compose up -d
# Open http://localhost:3002
```

---

## What it does

**Subjects.** A live tree of every subject a connection sees, virtualized and
filterable, with the last value and the rate per subject. Tuned for tens of
thousands of subjects at tens of thousands of messages per second.

**History that outlives the tab.** An optional SQLite copy of every message, with
retention, ranges from 15 minutes to 7 days, full-text search across subjects and
minute aggregates behind the long charts.

**JetStream, KV, Object Store.** Streams with their consumers, replication and
placement; buckets and stores as browsable, editable lists; JetStream domains for
hub and leaf setups.

**Filter and schema.** A [CEL](https://cel.dev/) expression such as
`payload.temp > 80 && subject.endsWith(".temp")` narrows tree, lists and charts.
The fields of a subject are read back from its own messages, with types, ranges
and drift.

**Alerts.** Rules watch a subject pattern for an expression that holds or for a
subject that fell silent. They run in the backend, so they keep firing without an
open browser, with an optional webhook.

**Requests.** Saved templates, request/reply, repeated runs with latency
percentiles and a histogram of where the replies landed.

**Monitoring and cluster.** Every node, the meta cluster and stream placement
through the system account; throughput history and a Prometheus endpoint.

**Teams.** Several NATS servers at once with token, user/password, NKey,
credentials or mutual TLS; `admin` and `viewer` roles, session cookies and an
audit log of every write.

**Support bundle.** A time range plus the server snapshot as one file, reopened in
any explorer and read like a live connection -- analysis without server access.

[All of it in detail]({% link features.md %}){: .btn .btn-outline }

---

## The layout

| Pane | |
|:--|:--|
| **Rail** | the modules: Subjects, JetStream, Key-Value, Object Store, Services, Requests, Monitoring, Cluster, Alerts, Audit log |
| **Explorer** | the tree or list of the current module |
| **Detail** | messages with JSON, raw and hex views, history, diff and charts; the stream, bucket, store and request editors; the dashboards |

---

## Next

- [Installation]({% link installation.md %}) -- every package, Docker, the binary, first connection
- [Deployment]({% link deployment.md %}) -- the web UI for a team, behind a proxy, with roles
- [Architecture]({% link architecture.md %}) -- how it is built, and the full HTTP API
- [Development]({% link development.md %}) -- build it from source
- [Changelog](https://github.com/blanpa/nats-explorer/blob/main/CHANGELOG.md) -- what changed per release
- [License]({% link license.md %}) -- AGPL v3.0 or later, and what that means for you
