---
layout: default
title: Architecture
nav_order: 4
---

# Architecture

NATS Explorer is a client-server application with a Go backend and React frontend, communicating via REST and WebSocket.

---

## Overview

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

## Go Backend

The backend is built with [chi](https://github.com/go-chi/chi) and [nats.go](https://github.com/nats-io/nats.go).

### Connection Store (`internal/connection/store.go`)

Manages multiple simultaneous NATS connections. Each connection gets:
- A unique ID and display name
- A color for visual distinction in the UI
- Thread-safe access via `sync.RWMutex`

### Handlers (`internal/handler/`)

One handler struct per feature domain, each receiving a pointer to the connection store:

| Handler              | Endpoints                                     |
|:-------------------- |:--------------------------------------------- |
| `ConnectionHandler`  | connect, disconnect, list, status, cluster     |
| `PublishHandler`     | publish, request-reply                         |
| `StreamsHandler`     | stream CRUD, message browsing, purge           |
| `ConsumersHandler`   | consumer CRUD per stream                       |
| `KVHandler`          | bucket CRUD, key CRUD, history                 |
| `ObjectStoreHandler` | store CRUD, object upload/download/delete      |
| `MonitoringHandler`  | proxy to NATS monitoring HTTP API              |
| `ServicesHandler`    | service discovery ($SRV.*)                     |

### Subscription Manager (`internal/subscription/`)

Manages real-time message subscriptions per connection:

- **Message handling** -- receives all messages matching subscribed subjects
- **Throttling** -- at most 10 messages/sec per subject reach the browser. On top of that the subject (or branch) the user has selected gets a dedicated budget (5000 msg/s) while all other subjects share a background budget of 1000 msg/s; within it the first message of a subject per second wins over repeats, so every subject keeps a fresh last value. The browser reports its selection with the `focus` websocket command.
- **Tree feed** -- the tree is sent as flat entries with a 160-char payload preview instead of nested nodes with full messages; after the initial snapshot only changed subjects are sent, and the interval backs off from 0.5 s to 2 s for very large trees. Websocket frames are permessage-deflate compressed.
- **Batching** -- collects messages in 100ms intervals before sending
- **Subject tree** -- builds a hierarchical tree from observed subjects with message counts and rates
- **Tree updates** -- broadcasts the subject tree every 500ms

### WebSocket Hub (`internal/ws/hub.go`)

Manages connected browser clients:

- Broadcast messages to all clients
- Per-client message sending (initial state on connect)
- Backpressure handling (64KB buffer, slow clients skipped)
- Concurrent-safe client tracking

---

## React Frontend

The frontend is a single-page application built with React 18, TypeScript, and Vite.

### State Management

[Zustand](https://github.com/pmndrs/zustand) manages global application state:
- Active connections and their statuses
- Subject trees per connection
- Current view selection
- Message history

### WebSocket Client

The frontend maintains a WebSocket connection to the backend for real-time updates:

| Event Type          | Direction | Description                    |
|:------------------- |:--------- |:------------------------------ |
| `connections`       | Server    | Updated connection list        |
| `message-batch`     | Server    | Batch of new messages plus `stats` (received/dropped/subjects). Binary payloads are base64 with `payloadType: "binary"` |
| `subject-tree`      | Server    | Flat subject entries (`{s,n,r,p,pt,ts,sz}` = subject, count, rate, payload preview, type, timestamp, size). `full: true` replaces the connection's tree (sent on connect); otherwise only changed subjects are listed. The browser rebuilds the hierarchy. Interval grows with the tree (0.5 s → 1 s above 2k subjects → 2 s above 10k) |
| `kv-update`         | Server    | Entry changed in a watched bucket (`connId`, `bucket`, `entry`) |
| `stream-msg`        | Server    | New message in a tailed stream (`connId`, `stream`, `message`) |
| `live-error`        | Server    | A watch could not be started |
| `focus`             | Client    | Subject or branch the user is viewing (`subject`, empty clears). Its messages bypass the shared background budget of the live feed |
| `kv-watch` / `kv-unwatch`       | Client | Start/stop a KV watch (`connId`, `bucket`) |
| `stream-tail` / `stream-untail` | Client | Start/stop an ordered-consumer tail (`connId`, `stream`) |

Watches are scoped to the websocket client that requested them and are cancelled when it disconnects.

### Component Organization

Components are organized by feature domain under `client/src/components/`:

```
components/
  connection/     # Connection dialog and panel
  subjects/       # Subject tree and node rendering
  messages/       # Message list, detail, payload viewer, value chart
  jetstream/      # Stream and consumer management
  kv/             # Key-Value store browser
  objectstore/    # Object Store browser
  services/       # Service discovery
  monitoring/     # Server monitoring dashboard
  cluster/        # Cluster topology view
  publish/        # Message publishing panel
  layout/         # Header, Sidebar, StatusBar, MainContent
```

### UI Framework

- **Tailwind CSS** for styling (dark theme)
- **Radix UI** for accessible primitives (dialogs, tabs, dropdowns)
- **Lucide React** for icons
- **Recharts** for value charts

---

## API Endpoints

All API endpoints are under `/api` and accept `connId` via query parameter or request body.

### Connection Management

| Method | Endpoint                   | Description          |
|:------ |:-------------------------- |:-------------------- |
| POST   | `/api/connect`             | Connect to NATS      |
| POST   | `/api/disconnect`          | Disconnect           |
| POST   | `/api/disconnect-all`      | Disconnect all       |
| GET    | `/api/connections`         | List connections     |
| GET    | `/api/status`              | Connection status    |
| GET    | `/api/server/{connId}`     | Server info, JetStream probe, client stats (`/api/cluster/{connId}` is an alias) |

### Messaging

| Method | Endpoint          | Description         |
|:------ |:----------------- |:------------------- |
| POST   | `/api/publish`    | Publish message     |
| POST   | `/api/request`    | Request-reply       |
| —      | `?domain=`        | On every JetStream/KV/Object Store route: address another JetStream domain for this call (defaults to the connection's `jsDomain` / `jsApiPrefix`) |
| GET    | `/api/cluster/{connId}/overview` | Cluster-wide view. With system-account credentials on the connection: `$SYS.REQ.SERVER.PING.STATSZ` and `.JSZ` fan-out to every server (servers, meta cluster, stream placement); otherwise the connected node's `varz`/`jsz` with an explanatory error |
| GET    | `/api/monitoring/{connId}/leafz` | Leaf node connections (also `routez`, `varz`, `jsz`, `connz`, `subsz`, `healthz`) |
| POST   | `/api/run`        | Repeat a publish or request `count` times (`concurrency`, `intervalMs`, `timeout`); subject, payload and headers may use `{{i}}`, `{{ts}}`, `{{uuid}}`, `{{rand:MIN-MAX}}`; returns counts, throughput, latency percentiles, sample replies and error samples (max 10 000 sends, 120 s) |

### JetStream Streams

| Method | Endpoint                          | Description         |
|:------ |:--------------------------------- |:------------------- |
| GET    | `/api/streams`                    | List streams        |
| POST   | `/api/streams`                    | Create stream       |
| GET    | `/api/streams/{name}`             | Get stream info     |
| PUT    | `/api/streams/{name}`             | Update stream       |
| DELETE | `/api/streams/{name}`             | Delete stream       |
| POST   | `/api/streams/{name}/purge`       | Purge stream        |
| GET    | `/api/streams/{name}/messages`    | Page of messages (`startSeq`, `limit`; newest page when `startSeq` is omitted). Fetched with an ephemeral ordered consumer in one round trip, falling back to per-sequence gets. |
| GET    | `/api/auth`                       | `{required: bool}`; the only route that never needs the token |
| DELETE | `/api/streams/{name}/messages/{seq}` | Delete message   |

### Consumers

| Method | Endpoint                                       | Description       |
|:------ |:---------------------------------------------- |:----------------- |
| GET    | `/api/streams/{stream}/consumers`              | List consumers    |
| POST   | `/api/streams/{stream}/consumers`              | Create consumer   |
| GET    | `/api/streams/{stream}/consumers/{consumer}`   | Get consumer      |
| DELETE | `/api/streams/{stream}/consumers/{consumer}`   | Delete consumer   |

### Key-Value

| Method | Endpoint                          | Description       |
|:------ |:--------------------------------- |:----------------- |
| GET    | `/api/kv`                         | List buckets      |
| POST   | `/api/kv`                         | Create bucket     |
| GET    | `/api/kv/{bucket}`                | List keys         |
| GET    | `/api/kv/{bucket}/status`         | Bucket status     |
| GET    | `/api/kv/{bucket}/{key}`          | Get entry + history |
| PUT/POST | `/api/kv/{bucket}/{key}`        | Put entry         |
| DELETE | `/api/kv/{bucket}/{key}`          | Delete entry      |
| POST   | `/api/kv/{bucket}/{key}/purge`    | Purge key history |
| DELETE | `/api/kv/{bucket}`                | Delete bucket     |

### Object Store

| Method | Endpoint                            | Description       |
|:------ |:----------------------------------- |:----------------- |
| GET    | `/api/objectstore`                  | List stores       |
| POST   | `/api/objectstore`                  | Create store      |
| GET    | `/api/objectstore/{store}`          | List objects      |
| GET    | `/api/objectstore/{store}/{name}`   | Download object   |
| PUT/POST | `/api/objectstore/{store}/{name}` | Upload object (raw body, or JSON `{data: base64}`) |
| DELETE | `/api/objectstore/{store}`          | Delete store      |
| DELETE | `/api/objectstore/{store}/{name}`   | Delete object     |

### Monitoring

| Method | Endpoint                                | Description            |
|:------ |:--------------------------------------- |:---------------------- |
| GET    | `/api/monitoring/{connId}/{endpoint}`   | Proxy to NATS monitor  |

Allowed endpoints: `varz`, `connz`, `routez`, `subsz`, `jsz`, `healthz`, `accountz`, `gatewayz`, `leafz`

### Services

| Method | Endpoint              | Description         |
|:------ |:--------------------- |:------------------- |
| GET    | `/api/services`       | Discover services   |
| GET    | `/api/services/stats` | Service statistics  |
| GET    | `/api/services/ping`  | Ping services       |

## Desktop app

`go-server/desktop.go` (build tag `desktop`) embeds `go-server/frontend/dist`, starts the same HTTP/WebSocket server on `127.0.0.1:<random port>` and opens a Wails window whose loader page redirects to it, so the UI code is identical to the browser build. Packaging lives in `scripts/build-desktop.sh` (per platform), `scripts/desktop-builder.Dockerfile` (Linux/Windows build environment) and `go-server/build/` (icon, Linux desktop entry, macOS Info.plist, Windows manifest and NSIS script). Releases are cut by `.github/workflows/release.yml` on `v*` tags.

### Where UI state lives

| Mode | Connections, templates, preferences | Credentials |
|---|---|---|
| Browser against a shared server | `localStorage` of that browser (`ne.*` keys) | same, unencrypted |
| Desktop app, or server with `STORAGE_DIR` | `settings.json` in the config dir, served by `GET/PUT/DELETE /api/settings[/{key}]`; the UI copies the entries into `localStorage` at start-up and writes through on every change | OS keyring via `zalando/go-keyring`, fallback `secrets.json` (0600); merged back into the connection list on read |

`GET /api/app` tells the UI which mode applies (`mode`, `storage`, `secrets`, `configDir`, `version`).
