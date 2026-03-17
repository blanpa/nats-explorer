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
- **Throttling** -- max 10 messages/sec per subject forwarded to clients
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
| `connection-status` | Server    | Single connection status change|
| `message-batch`     | Server    | Batch of new messages          |
| `subject-tree`      | Server    | Updated subject tree           |
| `error`             | Server    | Error notification             |

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
| GET    | `/api/cluster/{connId}`    | Cluster info         |

### Messaging

| Method | Endpoint          | Description         |
|:------ |:----------------- |:------------------- |
| POST   | `/api/publish`    | Publish message     |
| POST   | `/api/request`    | Request-reply       |

### JetStream Streams

| Method | Endpoint                          | Description         |
|:------ |:--------------------------------- |:------------------- |
| GET    | `/api/streams`                    | List streams        |
| POST   | `/api/streams`                    | Create stream       |
| GET    | `/api/streams/{name}`             | Get stream info     |
| PUT    | `/api/streams/{name}`             | Update stream       |
| DELETE | `/api/streams/{name}`             | Delete stream       |
| POST   | `/api/streams/{name}/purge`       | Purge stream        |
| GET    | `/api/streams/{name}/messages`    | Browse messages     |
| DELETE | `/api/streams/{name}/{seq}`       | Delete message      |

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
| POST   | `/api/kv/{bucket}/{key}`          | Put entry         |
| DELETE | `/api/kv/{bucket}/{key}`          | Delete entry      |
| DELETE | `/api/kv/{bucket}/{key}/purge`    | Purge key history |
| DELETE | `/api/kv/{bucket}`                | Delete bucket     |

### Object Store

| Method | Endpoint                            | Description       |
|:------ |:----------------------------------- |:----------------- |
| GET    | `/api/objectstore`                  | List stores       |
| POST   | `/api/objectstore`                  | Create store      |
| GET    | `/api/objectstore/{store}`          | List objects      |
| GET    | `/api/objectstore/{store}/{name}`   | Download object   |
| POST   | `/api/objectstore/{store}/{name}`   | Upload object     |
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
