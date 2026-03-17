# Contributing to NATS Explorer

Thank you for your interest in contributing. This guide covers the development setup, project conventions, and the process for submitting changes.

---

## Table of Contents

1. [Development Environment Setup](#development-environment-setup)
2. [Project Structure](#project-structure)
3. [Adding a New Feature](#adding-a-new-feature)
4. [Code Style Guidelines](#code-style-guidelines)
5. [Pull Request Process](#pull-request-process)
6. [Testing](#testing)
7. [Commit Message Format](#commit-message-format)

---

## Development Environment Setup

### Prerequisites

- **Node.js** 20 or later
- **pnpm** (installed via `corepack enable`)
- **Docker** (for the dev NATS server)

### Getting Started

```bash
# Clone the repository
git clone https://github.com/your-org/nats-explorer.git
cd nats-explorer

# Install all workspace dependencies
pnpm install

# Start the dev NATS server with sample data
pnpm nats:dev

# In another terminal, start the application
pnpm dev
```

This starts:
- Express server on `http://localhost:3002` (API + WebSocket)
- Vite dev server on `http://localhost:5173` (React client with HMR)
- Dev NATS server on `nats://localhost:4230` (with JetStream enabled)

Connect to `nats://localhost:4230` in the connection dialog to browse the simulated factory data.

### Useful Commands

```bash
pnpm dev              # Start client + server in dev mode
pnpm build            # Build all packages
pnpm nats:start       # Start dev NATS server
pnpm nats:stop        # Stop dev NATS server
pnpm nats:seed        # Seed streams, KV buckets, object stores
pnpm nats:simulate    # Start the UNS data simulator
pnpm nats:dev         # Start NATS, seed, and simulate in one command
```

---

## Project Structure

The project is a pnpm monorepo with four workspace packages:

```
nats-explorer/
  client/       # React frontend (Vite + Tailwind + Zustand)
  server/       # Express backend (nats.js + WebSocket)
  shared/       # Shared TypeScript type definitions
  dev/          # Dev NATS server, seed scripts, and simulator
```

### Client (`client/`)

The React application uses:
- **Zustand** for state management (`src/store/`)
- **Radix UI** for accessible primitives (dialogs, tabs, dropdowns)
- **Tailwind CSS** for styling
- **TanStack Virtual** for virtualized tree rendering
- **Lucide React** for icons

Components are organized by feature under `src/components/`:

| Directory      | Purpose                              |
| -------------- | ------------------------------------ |
| `connection/`  | Connection dialog and saved profiles |
| `subjects/`    | Subject tree and node rendering      |
| `messages/`    | Message list, detail, payload viewer |
| `jetstream/`   | Stream and consumer management       |
| `kv/`          | Key-Value store browser              |
| `objectstore/` | Object Store browser                 |
| `services/`    | NATS micro services discovery        |
| `monitoring/`  | Server monitoring dashboard          |
| `cluster/`     | Cluster topology view                |
| `publish/`     | Message publishing panel             |
| `layout/`      | Header, Sidebar, StatusBar, Main     |

### Server (`server/`)

The Express server is organized as:

- `src/nats/` -- Core NATS logic
  - `connection-manager.ts` -- Manages multiple NATS connections
  - `subscription-manager.ts` -- Handles subscriptions, message batching, and throttling
  - `subject-tree.ts` -- Builds and maintains the in-memory subject tree
- `src/routes/` -- REST API routes (one file per feature domain)
- `src/ws/handler.ts` -- WebSocket handler for real-time updates

### Shared (`shared/`)

TypeScript type definitions shared between client and server:

- `connection.ts` -- Connection configuration types
- `messages.ts` -- Message payload types
- `jetstream.ts` -- JetStream stream and consumer types
- `kv.ts` -- Key-Value store types
- `objectstore.ts` -- Object Store types
- `ws-events.ts` -- WebSocket event types

---

## Adding a New Feature

Most features follow a consistent pattern: a server-side route plus a client-side component.

### Step 1: Define shared types

If your feature introduces new data structures, add them to `shared/src/` and re-export from `shared/src/index.ts`.

```typescript
// shared/src/my-feature.ts
export interface MyFeatureData {
  id: string;
  name: string;
  // ...
}
```

### Step 2: Add a server route

Create a new route file in `server/src/routes/`:

```typescript
// server/src/routes/my-feature.ts
import { Router } from 'express';
import { getConnection } from '../nats/connection-manager.js';

export const myFeatureRouter = Router();

myFeatureRouter.get('/connections/:connId/my-feature', async (req, res) => {
  try {
    const conn = getConnection(req.params.connId);
    // ... use conn to interact with NATS
    res.json({ data: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

Register the router in `server/src/index.ts`:

```typescript
import { myFeatureRouter } from './routes/my-feature.js';
app.use('/api', myFeatureRouter);
```

### Step 3: Add a client component

Create a component under `client/src/components/my-feature/`:

```tsx
// client/src/components/my-feature/MyFeatureView.tsx
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export function MyFeatureView({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get(`/connections/${connectionId}/my-feature`)
      .then(res => setData(res.data));
  }, [connectionId]);

  return (
    <div>
      {/* render your feature */}
    </div>
  );
}
```

### Step 4: Add navigation

Add a sidebar entry in `client/src/components/layout/Sidebar.tsx` and handle the view in `MainContent.tsx`.

---

## Code Style Guidelines

### General

- **TypeScript** is used throughout. Avoid `any` where possible; use proper types from `shared/`.
- **Functional components** with hooks for all React code.
- **Named exports** are preferred over default exports.

### Naming Conventions

| Item             | Convention         | Example                    |
| ---------------- | ------------------ | -------------------------- |
| Files            | kebab-case         | `subject-tree.ts`          |
| Components       | PascalCase         | `SubjectTree.tsx`          |
| Functions        | camelCase          | `getConnection()`          |
| Types/Interfaces | PascalCase         | `StreamInfo`               |
| Constants        | SCREAMING_SNAKE    | `MAX_BATCH_SIZE`           |
| CSS classes      | Tailwind utilities | `className="flex gap-2"`   |

### Client

- Use Zustand stores for state that needs to be shared across components.
- Use local `useState` / `useEffect` for component-scoped state.
- Prefer Radix UI primitives for interactive elements (dialogs, dropdowns, tabs).
- Use Tailwind CSS classes directly; avoid CSS files.

### Server

- Each route file should handle one feature domain.
- Use Zod for request validation when accepting user input.
- Connection lookups go through the connection manager; never store raw NATS connections in route handlers.
- Return consistent JSON error responses: `{ error: string }`.

---

## Pull Request Process

1. **Fork** the repository and create a feature branch from `main`.
2. **Keep PRs focused** -- one feature or fix per pull request.
3. **Write a clear description** explaining what changed and why.
4. **Ensure the build passes**: run `pnpm build` before submitting.
5. **Update types** in `shared/` if your change affects the client-server contract.
6. **Test manually** against the dev NATS server (`pnpm nats:dev`).

### Branch Naming

Use descriptive branch names:

```
feature/object-store-upload
fix/websocket-reconnect
refactor/subject-tree-performance
```

---

## Testing

The project currently relies on manual testing against the dev NATS environment.

### Manual Testing Checklist

Before submitting a PR, verify the following:

- [ ] `pnpm build` completes without errors.
- [ ] The dev NATS server starts (`pnpm nats:start`) and seeds (`pnpm nats:seed`).
- [ ] The feature works correctly when connected to the dev NATS server.
- [ ] The subject tree still renders and updates in real time with the simulator running.
- [ ] No console errors in the browser or server terminal.
- [ ] The UI works with both the Vite dev server and the production build.

### Running a Production Build Locally

```bash
pnpm build
PORT=3002 node server/dist/index.js
# Open http://localhost:3002
```

---

## Commit Message Format

Use conventional commit messages with the following structure:

```
<type>(<scope>): <short description>

<optional body>
```

### Types

| Type       | When to use                                      |
| ---------- | ------------------------------------------------ |
| `feat`     | A new feature                                    |
| `fix`      | A bug fix                                        |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `style`    | Formatting, whitespace, or CSS-only changes      |
| `docs`     | Documentation changes                            |
| `build`    | Changes to build scripts or dependencies         |
| `chore`    | Maintenance tasks (dependency updates, configs)  |

### Scopes

Use the workspace package name or feature area:

```
feat(client): add value chart zoom controls
fix(server): handle connection timeout gracefully
refactor(shared): rename StreamConfig to StreamCreateRequest
build(docker): optimize multi-stage build layers
docs: update README installation section
```

### Examples

```
feat(client): add object store file upload with drag and drop

Support uploading files to NATS Object Store via drag-and-drop or
file picker. Files are chunked and uploaded through the server API.

fix(server): prevent duplicate subscriptions on reconnect

The subscription manager was not cleaning up previous subscriptions
when a WebSocket client reconnected, leading to duplicate messages.
```
