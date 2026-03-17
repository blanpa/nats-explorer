# Stage 1: Build
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source code
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/

# Build shared types, then server, then client
RUN pnpm --filter shared build
RUN pnpm --filter client build
RUN pnpm --filter server build

# Stage 2: Production
FROM node:20-alpine AS production

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY shared/package.json shared/
COPY server/package.json server/

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

# Copy built server
COPY --from=builder /app/server/dist server/dist
# Copy shared source (needed at runtime for type references via workspace link)
COPY --from=builder /app/shared/src shared/src
COPY --from=builder /app/shared/package.json shared/package.json
# Copy built client
COPY --from=builder /app/client/dist client/dist

ENV NODE_ENV=production
ENV PORT=3002

EXPOSE 3002

CMD ["node", "server/dist/index.js"]
