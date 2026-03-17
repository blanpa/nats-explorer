---
layout: default
title: Development
nav_order: 5
---

# Development Guide

---

## Prerequisites

- **Go** 1.24+
- **Node.js** 20+ with **pnpm** (`corepack enable`)
- **Docker** (for the dev NATS server)

---

## Getting Started

```bash
git clone https://github.com/blanpa/nats-explorer.git
cd nats-explorer

# Install frontend dependencies
pnpm install

# Start the dev NATS server with sample data
pnpm nats:dev

# Start Go backend + Vite frontend (hot reload)
pnpm dev
```

This starts:
- Go server on `http://localhost:3002` (API + WebSocket)
- Vite dev server on `http://localhost:5173` (React client with HMR)
- Dev NATS server on `nats://localhost:4230` (with JetStream enabled)

Connect to `nats://localhost:4230` in the connection dialog to browse the simulated factory data.

---

## Useful Commands

| Command              | Description                                    |
|:-------------------- |:---------------------------------------------- |
| `pnpm dev`           | Start Go backend + Vite frontend               |
| `pnpm dev:server`    | Start Go backend only                          |
| `pnpm dev:client`    | Start Vite frontend only                       |
| `pnpm build`         | Build shared types + client + Go server        |
| `pnpm nats:start`    | Start dev NATS server                          |
| `pnpm nats:stop`     | Stop dev NATS server                           |
| `pnpm nats:seed`     | Seed streams, KV buckets, object stores        |
| `pnpm nats:simulate` | Start UNS factory data simulator               |
| `pnpm nats:dev`      | Start NATS, seed, and simulate in one command  |

---

## Dev NATS Server

The `dev/` directory provides a self-contained development environment with a NATS server and a UNS (Unified Namespace) simulator that publishes realistic factory data.

The simulator publishes data on an ISA-95 style topic hierarchy:

```
uns.acme.factory-berlin.assembly.line-1.robot-01.position
uns.acme.factory-berlin.machining.line-2.cnc-01.spindle
uns.acme.factory-berlin.energy.main-meter.power
events.alarm.line-2.cnc-01
metrics.oee.line-1
```

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
  docs/                       # GitHub Pages documentation
  .github/workflows/          # CI + Release pipelines
```

---

## Adding a New Feature

Most features follow a consistent pattern:

### 1. Add a Go handler

Create a new handler in `go-server/internal/handler/`:

```go
type MyHandler struct {
    Store *connection.Store
}

func (h *MyHandler) List(w http.ResponseWriter, r *http.Request) {
    connID := getConnID(r)
    nc, err := h.Store.GetNC(connID)
    if err != nil {
        writeError(w, http.StatusBadRequest, err.Error())
        return
    }
    // ... use nc to interact with NATS
    writeJSON(w, result)
}
```

### 2. Register routes in main.go

```go
myHandler := &handler.MyHandler{Store: store}
r.Route("/api", func(r chi.Router) {
    r.Get("/my-feature", myHandler.List)
})
```

### 3. Add a React component

Create a component under `client/src/components/my-feature/`:

```tsx
export function MyFeatureView({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get(`/my-feature?connId=${connectionId}`)
      .then(setData);
  }, [connectionId]);
  return <div>{/* render */}</div>;
}
```

### 4. Add navigation

Add a sidebar entry in `Sidebar.tsx` and handle the view in `MainContent.tsx`.

---

## Code Style

### Go
- Standard Go conventions (`gofmt`, `go vet`)
- One handler struct per feature domain
- Use `writeJSON` / `writeError` helpers for consistent responses
- Thread-safe access to shared state via `sync.RWMutex`

### TypeScript / React
- Functional components with hooks
- Named exports (no default exports)
- Zustand for shared state, local `useState` for component state
- Tailwind CSS for styling (no CSS files)
- Radix UI for interactive primitives

---

## Commit Messages

Use conventional commits:

```
feat(server): add object store streaming download
fix(client): handle websocket reconnect gracefully
build(docker): optimize multi-stage build layers
```
