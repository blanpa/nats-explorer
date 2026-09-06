# Changelog

All notable changes to NATS Explorer. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.2.0] - 2026-09-06

Licensed under the Apache License 2.0 from this release on (previously MIT).

The first release that ships as an installable desktop application. Everything below was reviewed and verified against real NATS setups: a mutual-TLS server, a three-node cluster with a leaf node and JetStream domains, and a 20 000 msg/s stress load.

### Added
- **Desktop app** for Windows (per-user NSIS installer and portable zip), macOS (universal `.dmg`) and Linux (AppImage, `.deb`, tar.gz), built by the release workflow and smoke-tested on every platform runner.
- **Persistent settings** for the desktop app and for servers started with `STORAGE_DIR`: connections, request templates and preferences live in `settings.json` in the OS config directory; credentials go to the system keyring (Secret Service, Keychain, Credential Manager) or a user-only `secrets.json`.
- **Requests module**: Postman-style request templates in the sidebar with import/export, repeated runs (up to 10 000 sends, parallel senders, interval) with throughput and latency percentiles, and `{{i}}`, `{{ts}}`, `{{uuid}}`, `{{rand:MIN-MAX}}` variables. New `POST /api/run`.
- **Cluster module**: every server of the cluster, the JetStream meta cluster and stream placement via system-account credentials (`$SYS.REQ.SERVER.PING.*`), with a single-node fallback. New `GET /api/cluster/{connId}/overview`.
- **Monitoring history**: messages/s and bytes/s in and out, JetStream API rate, connections, subscriptions and CPU over time; cluster route and leaf node tables with traffic (`leafz`).
- **JetStream domains**: `jsDomain` / `jsApiPrefix` per connection, per-call `?domain=` override and a domain switch in the JetStream, KV and Object Store panes.
- **TLS with certificates**: CA, client certificate and key per connection (files or paste), insecure mode for test setups.
- **Value chart types**: line, area, step, bars, dots.
- Live KV watch and stream tail over the websocket, optional API token (`AUTH_TOKEN`), branch view for subject groups, saved recent sends, direct object download.
- Test coverage: Go unit and embedded-server end-to-end tests, Vitest, Playwright smoke suite, desktop smoke tests; CI builds and smoke-tests the Linux desktop app on every push.

### Changed
- **Live feed protocol**: the subject tree is sent as flat, delta-only entries with payload previews instead of full nested trees; focused subjects get their own budget, the rest share a background budget; websocket compression. Under the stress load this cut browser main-thread time from 62 % to 11 % and traffic from about 30 MB/s to about 150 KB/s.
- **UI redesign**: calmer visual language (figure strips instead of tiles, plain empty states, quiet destructive actions, no success toasts), system subjects and KV/Object backing streams hidden by default, module switches served from a result cache.
- Dependencies: Go 1.26, nats.go 1.53, nats-server 2.14 (tests and Docker image), Wails 2.11.

### Fixed
- Desktop app lost saved connections on every start (local storage was bound to a random port).
- Desktop window showed a Wails error page instead of the UI with Wails 2.11.
- "Not connected" flashed before the backend had reported its connections.
- Numerous smaller issues found in the review: throttled counters, tree memoisation, StrictMode double sockets, Docker build with pnpm 11, label/input linking in dialogs.

## [0.1.0-alpha.3] and earlier

Initial web UI: subject tree, message detail, JetStream, Key-Value, Object Store, services, monitoring, multi-connection, Docker and cross-compiled server binaries.

[0.2.0]: https://github.com/blanpa/nats-explorer/releases/tag/v0.2.0
