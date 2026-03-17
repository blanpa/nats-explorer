# Contributing to NATS Explorer

Thank you for your interest in contributing.

---

## Development Setup

### Prerequisites

- **Go** 1.24+
- **Node.js** 20+ with **pnpm** (`corepack enable`)
- **Docker** (for the dev NATS server)

### Getting Started

```bash
git clone https://github.com/blanpa/nats-explorer.git
cd nats-explorer
pnpm install

# Start dev NATS with sample data
pnpm nats:dev

# Start Go backend + React frontend
pnpm dev
```

- Go server: `http://localhost:3002`
- Vite dev server: `http://localhost:5173`
- Dev NATS: `nats://localhost:4230`

---

## Project Structure

```
nats-explorer/
  go-server/        # Go backend (chi router, nats.go)
  client/           # React frontend (Vite + Tailwind + Zustand)
  shared/           # Shared TypeScript types
  dev/              # Dev NATS server and simulators
  docs/             # GitHub Pages documentation
```

---

## Adding a Feature

1. **Go handler** -- Add to `go-server/internal/handler/`, register routes in `main.go`
2. **React component** -- Add to `client/src/components/`, wire into `Sidebar.tsx` / `MainContent.tsx`
3. **Shared types** (if needed) -- Add to `shared/src/`, re-export from `index.ts`

---

## Code Style

### Go
- Standard Go conventions (`gofmt`, `go vet`)
- One handler struct per feature domain
- Use `writeJSON` / `writeError` helpers

### TypeScript / React
- Functional components, named exports
- Zustand for shared state
- Tailwind CSS, Radix UI primitives

---

## Pull Request Process

1. Fork and create a feature branch from `main`
2. Keep PRs focused -- one feature or fix per PR
3. Ensure `go build ./...` and `pnpm build` pass
4. Test against the dev NATS server (`pnpm nats:dev`)
5. Use conventional commit messages:

```
feat(server): add object store streaming
fix(client): handle reconnect gracefully
```

---

## Testing

Before submitting:

- [ ] `cd go-server && go build ./... && go vet ./...`
- [ ] `pnpm --filter client build` (TypeScript check)
- [ ] Feature works against dev NATS server
- [ ] No console errors in browser or server
- [ ] Works with both Vite dev server and production build
