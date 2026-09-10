# NATS Explorer

A NATS management tool and message explorer inspired by MQTT Explorer, as a desktop app for Windows, macOS and Linux, or as a web UI served by a single Go binary. Browse subjects as a live tree, manage JetStream streams, Key-Value and Object Stores, run and repeat requests, watch servers, clusters and leaf nodes -- and keep the messages after the tab is closed.

Documentation: **[blanpa.github.io/nats-explorer](https://blanpa.github.io/nats-explorer/)** --
[installation](https://blanpa.github.io/nats-explorer/installation.html),
[features](https://blanpa.github.io/nats-explorer/features.html),
[deployment](https://blanpa.github.io/nats-explorer/deployment.html),
[architecture and API](https://blanpa.github.io/nats-explorer/architecture.html),
[development](https://blanpa.github.io/nats-explorer/development.html).
What changed per release is in the [changelog](CHANGELOG.md).

![The subject tree with the history, the value chart and the payload of a subject](docs/screenshots/subjects-dark.png)

<details>
<summary>More screenshots</summary>

![A stream with its limits, configuration and placement, light theme](docs/screenshots/jetstream-light.png)
![Alerts: what is firing, the rules behind it and the log](docs/screenshots/alerts-dark.png)
![Server monitoring with the throughput history](docs/screenshots/monitoring-dark.png)
![A repeated request with latency percentiles and the histogram of the replies](docs/screenshots/requests-dark.png)
![A Key-Value bucket with a key, its value and its revisions](docs/screenshots/kv-dark.png)
![Several NATS servers in the connection switcher](docs/screenshots/connections-dark.png)

</details>

[![Documentation](https://img.shields.io/badge/docs-blanpa.github.io-2ea44f.svg)](https://blanpa.github.io/nats-explorer/)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
![Go](https://img.shields.io/badge/go-1.26%2B-00ADD8.svg)
![NATS](https://img.shields.io/badge/NATS-2.10%2B-purple.svg)
[![Sponsor](https://img.shields.io/github/sponsors/blanpa?label=Sponsor&logo=githubsponsors&logoColor=white&color=EA4AAA)](https://github.com/sponsors/blanpa)

---

## Download

Every link hands out the newest build. The [Releases page](https://github.com/blanpa/nats-explorer/releases) has the same files with their version in the name, the release notes, every older build and a [`SHA256SUMS.txt`](https://github.com/blanpa/nats-explorer/releases/latest/download/SHA256SUMS.txt).

### Desktop app

| Platform | Download |
|---|---|
| Windows 10/11 | [installer (.exe)](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-windows-x64-setup.exe) · [portable (.zip)](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-windows-x64.zip) |
| macOS 11+ (Intel and Apple Silicon) | [disk image (.dmg)](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-macos-universal.dmg) · [app bundle (.zip)](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-macos-universal.zip) |
| Linux x64 | [AppImage](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-linux-x64.AppImage) · [.deb](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-linux-x64.deb) · [.tar.gz](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-desktop-linux-x64.tar.gz) |

The installers are not code-signed, so Windows and macOS ask once before running one: the [installation guide](https://blanpa.github.io/nats-explorer/installation.html#desktop-app) says what to click, and where the app keeps its settings and its message history.

### Server and Docker

One binary that serves the web UI on `http://localhost:3002`, with the UI bundled as `public/` next to it.

| Target | Download |
|---|---|
| Linux | [x64](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-linux-x64.tar.gz) · [arm64](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-linux-arm64.tar.gz) |
| macOS | [arm64](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-macos-arm64.tar.gz) · [x64](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-macos-x64.tar.gz) |
| Windows | [x64](https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-windows-x64.zip) |
| Docker | `ghcr.io/blanpa/nats-explorer:latest` ([all tags](https://github.com/blanpa/nats-explorer/pkgs/container/nats-explorer)) |

---

## Quick start

```bash
docker compose up -d          # NATS on 4222, NATS Explorer on 3002
```

Open `http://localhost:3002`. To run it against a NATS server you already have, use `docker compose -f docker-compose.standalone.yml up -d`, or the binary:

```bash
curl -fL -o nats-explorer-server.tar.gz \
  https://github.com/blanpa/nats-explorer/releases/latest/download/nats-explorer-server-linux-x64.tar.gz
mkdir -p nats-explorer && tar xzf nats-explorer-server.tar.gz -C nats-explorer --strip-components=1
cd nats-explorer && ./nats-explorer
```

Then add your server in the connection dialog. The [installation guide](https://blanpa.github.io/nats-explorer/installation.html) covers the other platforms, and [deployment](https://blanpa.github.io/nats-explorer/deployment.html) covers systemd, a reverse proxy, Kubernetes and roles.

---

## What it does

- **Subjects** -- a live tree of every subject a connection sees, virtualized and filterable, with the last value and the rate of each, and bookmarks for the ones worth coming back to
- **Messages** -- JSON, raw and hex; headers; history; diff to the previous message; MessagePack, Protobuf and Avro decoded into the tree
- **Charts** -- click a number in a payload to chart that field over time, drag across the chart to zoom into a stretch of it
- **History that outlives the tab** -- an optional SQLite copy with a retention, time ranges, full-text search, and exports in six shapes including a `nats` CLI replay script
- **JetStream** -- streams, consumers, messages and live tail; Key-Value buckets and Object Stores; JetStream domains for hub and leaf setups
- **Filter and schema** -- a [CEL](https://cel.dev/) expression such as `payload.temp > 80` narrows tree, lists and charts; each subject's fields are read back from its own messages, with a marker when they drift
- **Alerts** -- rules watch a subject pattern for a condition and keep firing with no browser open, with an optional webhook
- **Requests** -- saved templates, request/reply, and repeated runs with latency percentiles and a histogram of the replies
- **Monitoring and cluster** -- throughput history, every node of the cluster, the JetStream meta cluster and stream placement, and a Prometheus endpoint
- **Connections** -- several servers at once, with token, user/password, NKey, credentials or mutual TLS, and subscriptions changed live
- **Teams** -- `admin` and `viewer` roles, session cookies, and an audit log of every write
- **Support bundle** -- a time range plus the server snapshot as one file, reopened anywhere as a read-only connection
- **Dark and light** -- follows the operating system on first start

[All of it in detail](https://blanpa.github.io/nats-explorer/features.html)

---

## Configuration

The server is configured by environment variables. The ones most often needed:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3002` | HTTP server port |
| `AUTH_TOKEN` | -- | One shared token; every API and websocket request needs it, the UI asks once and keeps a session cookie |
| `AUTH_USERS` | -- | Users file (`name:role:bcrypt-hash`) with the roles `admin` and `viewer`; `nats-explorer hash-password` prints a hash |
| `STORAGE_DIR` | -- | Keep connections, templates and preferences on the server instead of in the browser; credentials go to the system keyring |
| `HISTORY_MB` | `256` | Memory budget for the recorded message history the UI pulls from |
| `HISTORY_DB` | -- | SQLite file for a persistent copy of the history; with a `STORAGE_DIR` it can be switched on in the UI instead |
| `BASE_PATH` | -- | Serve everything under a prefix (`/nats`), for a reverse proxy that does not strip it |

[Every variable, with the history and retention settings](https://blanpa.github.io/nats-explorer/installation.html#configuration)

---

## Security

Without `AUTH_TOKEN` or `AUTH_USERS` the backend has no authentication: bind the port to localhost or a trusted network only. With either, every API and websocket request needs a session, obtained once through the login and kept in an HttpOnly cookie; `AUTH_USERS` adds the roles `admin` and `viewer`, where a viewer cannot publish or change anything. Every write is recorded in an audit log that only an admin may read.

NATS credentials are held in memory. Saved connections, tokens and passwords included, live unencrypted in the browser's local storage unless `STORAGE_DIR` is set; then they go to a settings file on the server and the credentials to the system keyring, or to a `secrets.json` readable only by the user running the process.

---

## Development

```bash
bun install
bun run nats:dev    # dev NATS on :4230 with seed data
bun run dev         # Go backend on :3002, Vite on :5173
```

Needs Go 1.26+, Bun 1.2+ and Docker for the dev NATS server. Tests:

```bash
bun run --filter client test          # vitest
cd go-server && go test -race ./...   # Go unit and end-to-end tests (embedded nats-server)
bun run test:e2e                      # Playwright, against a running explorer
```

[Project layout, the build scripts and how a feature is added](https://blanpa.github.io/nats-explorer/development.html) ·
[architecture and the full HTTP API](https://blanpa.github.io/nats-explorer/architecture.html)

Releases are built by `.github/workflows/release.yml` on every `v*` tag: desktop installers for the three platforms, server binaries for five OS/arch pairs, the Docker image, and a `SHA256SUMS.txt` over all of them. See [docs/review-2026-09.md](docs/review-2026-09.md) for the findings of the September 2026 code review and redesign.

---

## Sponsor this project

This project is developed and maintained in my own time.
If it saves you some, consider supporting it:

<a href="https://github.com/sponsors/blanpa">
  <img height="41" alt="Sponsor on GitHub" src="https://img.shields.io/badge/Sponsor%20on%20GitHub-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white">
</a>
<a href="https://buymeacoffee.com/blanpa">
  <img height="41" alt="Buy Me a Coffee" src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png">
</a>

## License

[GNU Affero General Public License v3.0 or later](LICENSE) -- Copyright 2026 blanpa

Free to use, self-host and modify. If you distribute a modified version, or offer
it to others over a network, the users of that version have to be able to get its
source under the same license.

The name "NATS Explorer" and the project's marks are not covered by the license.
A modified version has to carry a different name and may not imply endorsement by
this project. For a use these terms do not fit, ask about a commercial license.
