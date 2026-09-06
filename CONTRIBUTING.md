# Contributing to NATS Explorer

Thanks for helping. The [development guide](docs/development.md) has the full setup, project structure and the "adding a feature" walkthrough; this page is the short version.

## Setup

- Go 1.26+, Node.js 22+ with pnpm (`corepack enable`), Docker for the dev NATS server
- `pnpm install`, then `pnpm nats:dev` (NATS on `nats://localhost:4230` with seed data) and `pnpm dev` (backend on :3002, Vite on :5173)

## Before you open a pull request

- `cd go-server && gofmt -l . && go vet ./... && go test -race ./...`
- `pnpm --filter client typecheck && pnpm --filter client test && pnpm --filter client build`
- `pnpm test:e2e` against a running backend (see the development guide)
- For changes to packaging: `scripts/build-desktop.sh --docker linux` and `scripts/smoke-desktop.sh go-server/build/bin/nats-explorer`

## Conventions

- Go: one handler struct per feature, `writeJSON` / `writeError` helpers, `jetStreamFor` for JetStream contexts, mutex-guarded shared state
- TypeScript/React: function components and hooks, Zustand for shared state, Tailwind classes plus the component classes in `index.css`, Radix UI primitives, lists and details through `useAsync` with a cache key
- UI language: figures in strips rather than tiles, plain empty states, quiet destructive actions, no success toasts
- Keep pull requests focused; conventional commit messages (`feat(server): …`, `fix(client): …`) are welcome
- Document user-visible changes in `CHANGELOG.md`

By contributing you agree that your contributions are licensed under the Apache License 2.0.
