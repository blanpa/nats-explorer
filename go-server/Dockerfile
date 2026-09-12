# Stage 1: Build client (Bun installs the workspace and runs the build scripts)
FROM oven/bun:1-alpine AS client-builder

WORKDIR /app

COPY package.json bun.lock ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY dev/package.json dev/
COPY e2e/package.json e2e/

RUN bun install --frozen-lockfile

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY client/ client/

RUN bun run --filter shared build
RUN bun run --filter client build

# Stage 2: Build Go server
FROM golang:1.26-alpine AS go-builder

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
