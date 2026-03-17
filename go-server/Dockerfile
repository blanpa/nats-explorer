# Stage 1: Build client
FROM node:20-alpine AS client-builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY shared/package.json shared/
COPY client/package.json client/

RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY client/ client/

RUN pnpm --filter shared build
RUN pnpm --filter client build

# Stage 2: Build Go server
FROM golang:1.24-alpine AS go-builder

WORKDIR /app

COPY go-server/go.mod go-server/go.sum ./
RUN go mod download

COPY go-server/ ./
RUN CGO_ENABLED=0 go build -o nats-explorer .

# Stage 3: Production
FROM alpine:3.20

WORKDIR /app

COPY --from=go-builder /app/nats-explorer .
COPY --from=client-builder /app/client/dist ./client/dist

ENV PORT=3002
ENV PUBLIC_PATH=/app/client/dist

EXPOSE 3002

CMD ["./nats-explorer"]
