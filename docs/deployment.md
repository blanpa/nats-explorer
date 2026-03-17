---
layout: default
title: Deployment
nav_order: 6
---

# Deployment

---

## Docker

### Docker Compose (with NATS)

The simplest production setup -- runs NATS and NATS Explorer together:

```yaml
# docker-compose.yml
services:
  nats:
    image: nats:latest
    ports:
      - "4222:4222"
      - "8222:8222"
    command: ["--jetstream", "--http_port", "8222", "--store_dir", "/data"]
    volumes:
      - nats-data:/data

  nats-explorer:
    build:
      context: .
      dockerfile: go-server/Dockerfile
    ports:
      - "3002:3002"
    environment:
      - PORT=3002
    depends_on:
      - nats

volumes:
  nats-data:
```

```bash
docker compose up -d
```

### Docker Compose (standalone)

Connect to an external NATS server:

```bash
docker compose -f docker-compose.standalone.yml up -d
```

Then configure the NATS server address in the web UI connection dialog.

### Pre-built Docker Image

```bash
docker run -d -p 3002:3002 ghcr.io/blanpa/nats-explorer:latest
```

---

## Standalone Binary

Download from [Releases](https://github.com/blanpa/nats-explorer/releases) and run directly. No runtime dependencies required.

### Linux

```bash
tar xzf nats-explorer-linux-x64.tar.gz
cd nats-explorer-linux-x64
PUBLIC_PATH=./public ./nats-explorer
```

### systemd Service

```ini
# /etc/systemd/system/nats-explorer.service
[Unit]
Description=NATS Explorer
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/nats-explorer
Environment=PORT=3002
Environment=PUBLIC_PATH=/opt/nats-explorer/public
ExecStart=/opt/nats-explorer/nats-explorer
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp -r nats-explorer-linux-x64 /opt/nats-explorer
sudo systemctl enable --now nats-explorer
```

### Windows

Extract the zip and run `nats-explorer.exe`:

```cmd
set PUBLIC_PATH=.\public
set PORT=3002
nats-explorer.exe
```

Or create a Windows Service using [NSSM](https://nssm.cc/) or similar.

---

## Reverse Proxy

### Nginx

```nginx
server {
    listen 80;
    server_name nats-explorer.example.com;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

The `Upgrade` and `Connection` headers are required for WebSocket support.

### Caddy

```
nats-explorer.example.com {
    reverse_proxy localhost:3002
}
```

Caddy handles WebSocket upgrades automatically.

---

## CI/CD

Releases are fully automated via GitHub Actions. Push a version tag to trigger the pipeline:

```bash
git tag v1.0.0
git push --tags
```

The release workflow:

1. **Build** -- Cross-compiles Go binaries for 5 platforms (linux-x64, linux-arm64, windows-x64, macos-x64, macos-arm64) and builds the React frontend
2. **Docker** -- Builds and pushes a Docker image to GitHub Container Registry (GHCR)
3. **Release** -- Creates a GitHub Release with all binary archives

### Release Targets

| Archive                              | Platform            |
|:------------------------------------ |:------------------- |
| `nats-explorer-linux-x64.tar.gz`     | Linux x86_64        |
| `nats-explorer-linux-arm64.tar.gz`   | Linux ARM64         |
| `nats-explorer-windows-x64.zip`      | Windows x86_64      |
| `nats-explorer-macos-x64.tar.gz`     | macOS Intel         |
| `nats-explorer-macos-arm64.tar.gz`   | macOS Apple Silicon |
| `ghcr.io/blanpa/nats-explorer`       | Docker image        |

Each archive contains the binary and a `public/` folder with the web UI.
