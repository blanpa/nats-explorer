---
layout: default
title: Features
nav_order: 3
---

# Features

---

## Subject tree

- Subjects split by `.` into a virtualized tree with inline value preview, message count and rate per subject and per branch
- Filter with several words, keyboard navigation, expand/collapse all
- System roots (`$JS`, `$KV`, `$SYS`, `_INBOX`, …) hidden by default behind a toggle
- Selecting a branch shows the recent messages of everything below it
- Built for large subject spaces: the server sends a flat delta of changed subjects with short payload previews, the browser rebuilds the hierarchy; the interval backs off for very large trees

## Message detail

- JSON, raw and hex views; headers; history of the last messages; diff to the previous message
- Click a number in the JSON to chart it over time as line, area, step, bars or dots
- Publish drawer with templates and recent sends

## JetStream

- Streams: list, create, edit, purge, delete; page through messages from the newest sequence; live tail; delete single messages
- Consumers: list, create, delete, state
- KV/Object backing streams (`KV_*`, `OBJ_*`) hidden by default behind a toggle
- **JetStream domains**: a connection can carry a `jsDomain` or API prefix (leaf nodes behind a hub and vice versa), and the JetStream, KV and Object Store panes have a domain switch for ad-hoc changes

## Key-Value

- Buckets with history size; keys with current value, revision and full history
- Create, edit, delete and purge keys; create and delete buckets
- Live updates through a server-side watch

## Object Store

- Stores with size and chunk count; objects with description, digest and modification time
- Drag & drop or file upload (streamed), direct download, delete objects and stores

## Services

- Discover NATS micro services (`$SRV.INFO`, `STATS`, `PING`), see endpoints, request counts, errors and processing time

## Requests

- Saved request templates in the sidebar: name, publish or request/reply, subject, headers, payload, timeout
- Create, edit, duplicate, delete; import and export as JSON to share collections
- **Repeated runs**: send a template up to 10 000 times with parallel senders and an optional pause; read sent/ok/errors, throughput, latency min/avg/p50/p95/max and the first replies
- Variables replaced per message in subject, payload and headers: `{{i}}` (counter), `{{ts}}` (unix milliseconds), `{{uuid}}`, `{{rand:MIN-MAX}}`

## Monitoring

- Server health strip: CPU, memory, connections, subscriptions, slow consumers, traffic, routes and leaf nodes
- Throughput history: messages/s and bytes/s in vs out, JetStream API calls and errors, connections, subscriptions, CPU
- JetStream usage, subscription statistics, client connection table
- Cluster routes and leaf nodes with RTT, subscriptions and traffic per peer

The monitoring URL defaults to port 8222 of the first server and can be set per connection.

## Cluster

- Every server of the cluster with version, uptime, CPU, memory, connections, subscriptions, traffic, routes and JetStream usage; the meta leader is marked
- JetStream meta cluster: leader and peers with current/lagging/offline state
- Every stream with account, storage, replicas, leader and placement per peer
- Needs system-account (`$SYS`) credentials on the connection; without them the module shows the connected node only and says so
- A second tab lists the per-connection server details

## Connections

- Several servers at once, colour-coded; switch between them
- Authentication: none, token, username/password, NKey seed, credentials file (JWT)
- TLS with CA certificate, client certificate and key (pasted or loaded from files), plus an insecure mode for test setups
- Optional system-account credentials for the Cluster module
- Subscriptions and system subjects per connection, monitoring URL, JetStream domain / API prefix

## Performance

- Per subject at most 10 msg/s reach the browser; the selected subject or branch gets a dedicated budget, all other subjects share a background budget where the first message of a subject per second wins
- Message batching (100 ms), compressed websocket frames, tree deltas instead of full trees
- Module switches are served from a result cache and refreshed in the background
- Measured under 5 000 subjects at 20 000 msg/s: backend around 5 % CPU and 41 MB, browser main thread around 11 % busy
