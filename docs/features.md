---
layout: default
title: Features
nav_order: 3
has_children: true
---

# Features

NATS Explorer provides a comprehensive set of tools for managing and monitoring NATS servers.

---

## Subject Tree Browsing

Browse all NATS subjects in a hierarchical tree view, similar to MQTT Explorer.

- Subjects are split by `.` into a navigable tree structure
- Each node shows the latest message value inline
- Live message count and rate per subject (messages/sec)
- Click any subject to view full message details
- Automatic throttling for high-throughput subjects (max 10 msg/sec per subject forwarded to UI)

---

## Multi-Connection Support

Connect to multiple NATS servers simultaneously.

- Each connection gets a unique color for visual distinction
- Switch between connections to view their subject trees independently
- All connections share the same WebSocket for real-time updates
- Supports all NATS authentication methods

---

## JetStream Management

Full CRUD operations for JetStream resources.

### Streams
- List all streams with state overview (messages, bytes, consumers)
- Create streams with full configuration (retention, storage, limits)
- Update stream configuration
- Delete and purge streams
- Browse messages by sequence number with pagination

### Consumers
- List consumers per stream
- Create consumers with delivery/ack policies
- View consumer state (delivered, ack floor, pending)
- Delete consumers

---

## Key-Value Store

Browse and manage NATS JetStream Key-Value stores.

- List all KV buckets with metadata
- Browse keys within a bucket
- View current value with formatted JSON
- Full revision history per key
- Create, update, and delete keys
- Purge key history
- Create and delete buckets

---

## Object Store

Manage NATS JetStream Object Stores.

- List object stores with size and chunk info
- Browse objects within a store
- Upload objects (base64 encoded)
- Download objects as files
- Delete objects
- Create new stores

---

## Services Discovery

Discover and inspect NATS micro services.

- Discover services via `$SRV.INFO`
- View service statistics via `$SRV.STATS`
- Ping services via `$SRV.PING`

---

## Server Monitoring

Proxy to NATS server monitoring HTTP endpoints.

| Endpoint   | Description                    |
|:---------- |:------------------------------ |
| `varz`     | Server health and version info |
| `connz`    | Connection statistics          |
| `routez`   | Route information              |
| `subsz`    | Subscription statistics        |
| `jsz`      | JetStream account info         |
| `healthz`  | Health check                   |
| `accountz` | Account information            |
| `gatewayz` | Gateway information            |
| `leafz`    | Leaf node information          |

The monitoring URL is auto-derived from the NATS connection (port + 4000), or can be configured manually per connection.

---

## Publish & Request-Reply

### Publish
- Send messages to any NATS subject
- Support for custom headers
- JSON and plain text payloads

### Request-Reply
- Send request messages and view responses
- Configurable timeout (default 5 seconds)
- Automatic payload type detection (string/json/binary)

---

## Live Value Charts

When viewing a message with numeric JSON fields, NATS Explorer automatically offers charting capabilities.

- Select any numeric field from the payload
- Values are plotted over time as new messages arrive
- Useful for monitoring sensor data, metrics, and telemetry

---

## Authentication

All common NATS authentication methods are supported:

| Method            | Description                              |
|:----------------- |:---------------------------------------- |
| None              | No authentication                        |
| Token             | Bearer token                             |
| Username/Password | Basic credentials                        |
| NKey              | Ed25519 key pair (seed)                  |
| JWT/Credentials   | NATS credentials file                    |
| TLS               | TLS client certificates                  |

---

## Performance

NATS Explorer is designed for high-throughput environments:

- **Server-side throttling** -- max 10 messages/sec per subject forwarded to the UI
- **Message batching** -- messages are collected in 100ms batches before sending via WebSocket
- **Subject tree updates** -- tree is rebuilt every 500ms, not on every message
- **WebSocket backpressure** -- slow clients are skipped (64KB buffer threshold)
- **Go backend** -- low memory footprint, high concurrency
