---
layout: default
title: Deployment
nav_order: 6
---

# Deployment

The desktop app needs no deployment: install it, add connections, done. This page covers running the web UI for a team.

---

## Docker

### Docker Compose (with NATS)

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
    image: ghcr.io/blanpa/nats-explorer:latest
    ports:
      - "3002:3002"
    environment:
      - PORT=3002
      # - AUTH_TOKEN=change-me
    depends_on:
      - nats

volumes:
  nats-data:
```

```bash
docker compose up -d
```

### Standalone container

```bash
docker run -d -p 3002:3002 -e AUTH_TOKEN=change-me ghcr.io/blanpa/nats-explorer:latest
```

---

## Server binary

Download `nats-explorer-server-<version>-<os>-<arch>` from [Releases](https://github.com/blanpa/nats-explorer/releases); the UI is bundled as `public/` next to the binary.

### systemd

```ini
# /etc/systemd/system/nats-explorer.service
[Unit]
Description=NATS Explorer
After=network.target

[Service]
Type=simple
User=nats-explorer
WorkingDirectory=/opt/nats-explorer
Environment=PORT=3002
Environment=AUTH_TOKEN=change-me
# optional: keep connections and templates on the server (single-user)
# Environment=STORAGE_DIR=/var/lib/nats-explorer
# Environment=NO_KEYRING=1
ExecStart=/opt/nats-explorer/nats-explorer
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp -r nats-explorer-server-0.2.0-linux-x64 /opt/nats-explorer
sudo systemctl enable --now nats-explorer
```

On Windows, run `nats-explorer.exe` from the extracted folder or wrap it with [NSSM](https://nssm.cc/).

---

## Security

- The backend talks to NATS with the credentials the UI sends; the web UI stores them in the browser's local storage without encryption. Put the UI behind `AUTH_TOKEN` and TLS (reverse proxy) when it is reachable by others.
- With `STORAGE_DIR`, credentials go to the keyring or a `secrets.json` readable only by the service user.
- Websocket upgrades are accepted from the same host and loopback origins only.

---

## Reverse proxy

### Nginx

```nginx
server {
    listen 443 ssl;
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

The `Upgrade` and `Connection` headers are required for the websocket.

### Caddy

```
nats-explorer.example.com {
    reverse_proxy localhost:3002
}
```

---

## Release pipeline

Pushing a `v*` tag runs `.github/workflows/release.yml`:

1. **frontend** -- builds and tests the UI once
2. **desktop-linux / desktop-windows / desktop-macos** -- build the installers on their native runners and smoke-test them (Linux and macOS: launch under a display and check API, UI and websocket; Windows: silent install, launch, check, uninstall)
3. **server** -- headless binaries for five OS/arch pairs
4. **docker** -- image on GHCR tagged with the version
5. **release** -- GitHub release with every file and `SHA256SUMS.txt`

A manual `workflow_dispatch` run produces the artifacts without publishing.

| File | Platform |
|:-- |:-- |
| `nats-explorer-desktop-<v>-windows-x64-setup.exe`, `.zip` | Windows desktop |
| `nats-explorer-desktop-<v>-macos-universal.dmg`, `.zip` | macOS desktop |
| `nats-explorer-desktop-<v>-linux-x64.AppImage`, `.deb`, `.tar.gz` | Linux desktop |
| `nats-explorer-server-<v>-{linux-x64,linux-arm64,windows-x64,macos-x64,macos-arm64}` | Server |
| `ghcr.io/blanpa/nats-explorer:<v>` | Docker |

Installers are not code-signed; see the notes on the [Installation]({% link installation.md %}) page.
