---
layout: default
title: Development
nav_order: 6
---

# Development Guide

---

## Prerequisites

- **Go** 1.26+
- **Bun** 1.2+ (package manager and script runner; the tools run on Bun, Node.js is not required)
- **Docker** (dev NATS server, Linux desktop builder image)
- For desktop builds: the Wails CLI (`go install github.com/wailsapp/wails/v2/cmd/wails@v2.11.0`) and, on Linux, `libgtk-3-dev libwebkit2gtk-4.1-dev`

---

## Getting started

```bash
git clone https://github.com/blanpa/nats-explorer.git
cd nats-explorer
bun install
bun run nats:dev   # dev NATS on nats://localhost:4230 with seed data and a simulator
bun run dev        # Go backend on :3002 + Vite on :5173 with hot reload
```

Connect to `nats://localhost:4230` in the connection dialog.

| Command | Description |
|:-- |:-- |
| `bun run lint` / `bun run format` | Biome lint and formatting check / apply (`biome.json`) |
| `bun run dev` | Go backend + Vite frontend |
| `bun run build` | Shared types, client and Go server |
| `bun run nats:start` / `nats:stop` / `nats:seed` / `nats:simulate` | Dev NATS server pieces (`NATS_URL` picks the server) |
| `bun run --filter client test` | Vitest: pure unit tests in Node, component tests (`*.test.tsx`, `@vitest-environment jsdom`) with Testing Library |
| `cd go-server && go test -race ./...` | Go unit and end-to-end tests (embedded nats-server) |
| `bun run test:e2e` | Playwright suite, one file per module in `e2e/` with shared helpers in `support.ts` against `http://localhost:3002` (`NE_URL`, `NATS_URL`, `PW_CHROME`) |
| `scripts/build-desktop.sh` with `linux`, `windows` or `macos` | Desktop packages for one platform (`--docker` runs Linux and Windows in the builder image) |
| `scripts/smoke-desktop.sh <binary>` | Launches a desktop build headless and checks API, UI, websocket and settings persistence |

---

## Project structure

```
nats-explorer/
  go-server/                  # Go backend
    main.go                   # Server entry point; desktop.go: Wails window (build tag `desktop`)
    server.go                 # Router wiring
    build/                    # Desktop packaging assets (icon, Info.plist, NSIS script, desktop entry)
    internal/
      connection/             # Multi-connection NATS store (main + system-account connections, TLS)
      handler/                # HTTP handlers per feature (streams, consumers, kv, objectstore, publish, run, services, monitoring, cluster, settings, live)
      settings/               # File-backed UI settings, keyring secrets
      subscription/           # Subscriptions, forwarding budgets, subject tree feed
      ws/                     # WebSocket hub
  client/src/
    components/               # subjects, jetstream, kv, objectstore, services, requests, monitoring, cluster, connection, layout, ui
    lib/                      # API client, websocket, storage sync, saved connections/requests, utilities
    store/                    # Zustand stores
  shared/                     # TypeScript types shared by client and (documented) API
  e2e/                        # Playwright smoke suite
  scripts/                    # Desktop build, builder Dockerfile, smoke tests
  dev/                        # Dev NATS server, seed and simulator
  docs/                       # This site, architecture notes, review log
  .github/workflows/          # ci.yml, release.yml, pages.yml
```

---

## Adding a feature

1. **Handler** in `go-server/internal/handler/`: a struct with `Store *connection.Store`, `writeJSON` / `writeError` helpers, `connIDFromRequest(r)` for the connection id, `jetStreamFor(store, r)` for a JetStream context that honours the connection's domain.
2. **Route** in `go-server/server.go` inside the `/api` group (token middleware applies).
3. **Types** in `shared/src/` and a call in `client/src/lib/api.ts`.
4. **Component** under `client/src/components/<feature>/`; lists in the explorer pane use `useAsync` with a cache `key`, detail views the same.
5. **Module** (if it needs its own rail entry): add it to `MODULES` in `client/src/store/index.ts`, an icon in `layout/Rail.tsx`, and the panes in `layout/Explorer.tsx` / `layout/Detail.tsx`.
6. **Tests**: a Go test next to the handler or in `server_test.go` (embedded nats-server), Vitest for pure client logic and for components whose behaviour depends on state or role, and a Playwright step if the flow is user-visible.

---

## Code style

- Go: `gofmt`, `go vet`, one handler struct per feature, mutex-guarded shared state.
- TypeScript/React: function components and hooks, Zustand for shared state, Tailwind classes plus the component classes in `index.css`, Radix UI primitives.
- UI language: figures in strips rather than tiles, plain empty states, destructive actions quiet until hovered, no success toasts.

## Commit messages

Conventional commits are welcome (`feat(server): …`, `fix(client): …`, `ci: …`).
