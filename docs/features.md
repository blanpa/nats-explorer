---
layout: default
title: Features
nav_order: 3
---

# Features

<details open markdown="block">
  <summary class="text-delta">Contents</summary>
1. TOC
{:toc}
</details>

---

## Subject tree

- Numeric fields of the latest message as sparklines with the current value; the history rail is open by default
- Keyboard: `/` focuses the filter of the current module, Escape clears it, `j`/`k` walk the subject tree, arrow keys expand and collapse
- Watch several subjects at once: Ctrl/Cmd-click adds subjects to the selection; the detail pane then shows the latest value and rate of each and one list of everything arriving on any of them, newest first
- Subjects split by `.` into a virtualized tree with inline value preview, message count and rate per subject and per branch. The server keeps the tree and sends a tab only the branches it has expanded; the filter runs on the server over the whole namespace, so very large subject spaces cost what is on screen
- Filter with several words, keyboard navigation, expand/collapse all
- System roots (`$JS`, `$KV`, `$SYS`, `_INBOX`, …) hidden by default behind a toggle
- Selecting a branch shows the recent messages of everything below it
- Built for large subject spaces: the server sends a flat delta of changed subjects with short payload previews, the browser rebuilds the hierarchy; the interval backs off for very large trees

## Bookmarks

The star in the subject header keeps a subject, with an optional name, group and note. Bookmarks appear as their own panel above the tree and select their subject even when it is filtered out or has not sent anything yet; the note shows under the subject header. Selecting a subject that way, or from an alert or a message list, opens the branches above it in the tree. They travel with the other settings, so with file storage they follow the user to another browser.

## Clearing the history

The eraser in the subject header forgets the recorded messages of that subject. On a branch it takes everything below it as well, and the confirmation says which of the two is about to happen. The rest of the recorded history stays. Both the memory and the persistent copy are cleared, so a time range does not bring the messages back, and the subject leaves the tree until it sends again. The eraser in the Subjects pane header still clears everything at once.

## Payload filter

The filter icon next to the subject filter opens an expression field. The expression is written in [CEL](https://cel.dev/) and the server evaluates it against the last message of every subject, so only matching subjects stay in the tree, and the same expression narrows the message list, the history search, time ranges and chart series.

An expression sees `subject`, `payload` (the parsed JSON document, or the text for other payloads), `raw`, `kind`, `headers`, `size`, `timestamp` and `reply`, plus the CEL string and math functions.

```
payload.temp > 80
has(payload.alarm) && payload.alarm.code in [3, 4]
subject.endsWith(".temp") && payload.unit == "C"
raw.contains("error") || size > 100000
payload.tags.exists(t, t == "hot")
```

A message that does not have the field simply does not match; a broken expression is reported instead of showing an empty tree. Expressions are compiled once and cached, and they only run over what a tab looks at, so a filter costs nothing on subjects nobody watches.

## Search

The search field over the recorded history looks at a subject and everything below it, or across every subject: the toggle sits in the results line. Clicking a hit shows its payload under the list, with a button to open the subject it came from; the same holds for the list of a branch and for several subjects watched at once. With a persistent history the search runs on a full-text index, so a word or a prefix like `convey*` is fast even over days; a fragment that the index cannot express falls back to a scan and still finds it.

Charts over more than six hours are drawn from minute aggregates that the writer keeps alongside the messages: minimum, maximum and average per minute and numeric field. A week of data is then a few hundred points instead of a few hundred thousand, and the chart says "per minute" when it shows them.

## Alerts

<img src="{{ '/screenshots/alerts-dark.png' | relative_url }}" alt="The Alerts module: what is firing, the rules behind it and the log" loading="lazy">

A rule watches a subject pattern for a condition: an expression that holds, a subject that stopped sending, or both. The backend evaluates the rules on the message path, so they keep working while no browser is open, and an optional webhook receives a JSON POST on every state change.

The Alerts module lists what is firing right now, the rules with the number of subjects each one matches, and a log of state changes. A rule can be tried against the recorded messages before it is saved, which answers "how many of my messages would this match" without waiting. The rail badge counts the active alerts from every module, and a new warning or critical alert raises a toast.

## Message detail

- JSON, raw and hex views; headers; history of the last messages; diff to the previous message
- Payload decoders: rules per subject pattern decode MessagePack, Protocol Buffers (paste the `.proto`, name the message type) or Avro (paste the schema) into the JSON tree; the rules are kept with the other settings
- Click a number in the JSON to chart it over time as line, area, step, bars or dots
- Click a point in that chart to see the message behind it: the value decides which one, so a peak opens the message that caused it. Points older than what the browser holds are fetched from the persistent history
- The other way round too: the message currently shown is marked in the chart, and its value and time head the chart instead of the newest ones. Picking another message in the history rail moves the marker with it
- Publish drawer with templates and recent sends

## Schema

Every subject carries a derived schema under its payload: which fields the JSON messages contain, their types with counts, how often each field appears, its value range or enumeration, and an example. Nobody maintains it; it is read from the recorded messages and refreshes every ten seconds.

When the newer half of the messages looks different from the older half, the section is marked with drift and the changed fields say what happened: a type that changed, a field that is no longer sent, or one that just appeared. That catches a device or gateway whose output silently changed, which otherwise only surfaces when something downstream breaks. Drift needs at least five messages per half, so an optional field or an integer that becomes a decimal is never reported as a change.

## JetStream

<img src="{{ '/screenshots/jetstream-light.png' | relative_url }}" alt="A stream with its limits, configuration and placement, in the light theme" loading="lazy">

- Streams: list, create, edit, purge, delete; page through messages from the newest sequence; live tail; delete single messages
- Consumers: list, create, delete, state
- KV/Object backing streams (`KV_*`, `OBJ_*`) hidden by default behind a toggle
- **JetStream domains**: a connection can carry a `jsDomain` or API prefix (leaf nodes behind a hub and vice versa), and the JetStream, KV and Object Store panes have a domain switch for ad-hoc changes

### Consumers and replication

A consumer row carries its lag, the distance between the stream head and what the consumer has delivered, with a warning arrow when the backlog grew over the last samples. Opening a row shows pending and ack-pending over time, sampled on every refresh of the list.

A stream that mirrors or sources from another says so, with the lag and the time since the last activity, and every stream lists which other streams copy from it. Each name is a link to that stream.

## Key-Value

<img src="{{ '/screenshots/kv-dark.png' | relative_url }}" alt="A Key-Value bucket with a key, its value and its revisions" loading="lazy">

- Buckets with history size; keys with current value, revision and full history
- Create, edit, delete and purge keys; create and delete buckets
- Live updates through a server-side watch

## Object Store

- Stores with size and chunk count; objects with description, digest and modification time
- Drag & drop or file upload (streamed), direct download, delete objects and stores

## Services

- Discover NATS micro services (`$SRV.INFO`, `STATS`, `PING`), see endpoints, request counts, errors and processing time

## Requests

<img src="{{ '/screenshots/requests-dark.png' | relative_url }}" alt="A request template run 400 times, with latency percentiles and the histogram of the replies" loading="lazy">

- Saved request templates in the sidebar: name, publish or request/reply, subject, headers, payload, timeout
- Create, edit, duplicate, delete; import and export as JSON to share collections
- **Repeated runs**: send a template up to 10 000 times with parallel senders and an optional pause; read sent/ok/errors, throughput, latency min/avg/p50/p95/max and the first replies
- Variables replaced per message in subject, payload and headers: `{{i}}` (counter), `{{ts}}` (unix milliseconds), `{{uuid}}`, `{{rand:MIN-MAX}}`

## Response times

A repeated request run reports the latency as p50, p95, p99, minimum, maximum and average, plus a histogram of where the replies landed. The shape matters: a summary hides a run where most replies are fast and a few sit on the timeout.

## Monitoring

<img src="{{ '/screenshots/monitoring-dark.png' | relative_url }}" alt="The monitoring dashboard with the throughput history" loading="lazy">

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

<img src="{{ '/screenshots/connections-dark.png' | relative_url }}" alt="Several NATS servers side by side in the connection switcher" loading="lazy">

- Several servers at once, colour-coded; switch between them
- Authentication: none, token, username/password, NKey seed, credentials file (JWT)
- TLS with CA certificate, client certificate and key (pasted or loaded from files), plus an insecure mode for test setups
- Optional system-account credentials for the Cluster module
- Monitoring URL, JetStream domain / API prefix per connection
- "Connect when the server starts": with `STORAGE_DIR` the backend opens marked connections itself, so history and metrics collect without a browser
- Changing the subscriptions keeps what the other patterns collected: only the subjects that no pattern covers any more are forgotten, and the persistent history keeps even those
- Subscriptions are managed live in the Subjects pane: one row per pattern with the subjects it matches and its message rate, a field to add patterns (comma or space separated; adding a concrete pattern replaces the catch-all `>`), an X to unsubscribe, and toggles for the system subjects ($SYS, $JS, $KV, $SRV). Every change applies at once without reconnecting and is remembered in the saved connection

## Security

- `AUTH_TOKEN`: one shared token, entered once in the UI
- `AUTH_USERS`: accounts with the roles `admin` and `viewer`; the UI shows a login and hides the write actions from viewers, the backend rejects their writes with `403`
- Sessions are HttpOnly cookies set by `POST /api/login`; no credential sits in the websocket URL or in browser storage
- `GET /metrics` for Prometheus, protected like the API

## Support bundle

The package icon in the monitoring header writes one zip: the recorded messages of a time range, the server snapshot of that moment (varz, jsz, connz, subsz, routez, leafz, healthz), the streams with their consumers and the KV buckets. The export menu of a subject offers the same for that subject and everything below it. Without a persistent history only what is in memory can be exported.

"Open support bundle" in the connection switcher reads such a file back. It appears as a read-only connection marked "bundle": the subject tree, the message history, the payload filter, the schema and the charts work on it exactly as on a live server, and nothing can be published through it. The monitoring module shows what the file contains instead of polling a server. Closing the bundle drops its messages again; the file stays.

That way an incident can be looked into without access to the system: whoever has the file has the data.

## Audit log

Every write under `/api` is recorded with the account, the object it acted on, the source address and the result: publishing, creating, editing, deleting, changing subscriptions or connections. Reads are not recorded, refused writes are, so a viewer who tried something shows up too. The log lives in the settings directory as `audit.log` when there is one, otherwise in memory, and only an admin may read it.

## Performance

- The browser only receives the messages of the subject or branch it looks at; the backend records every message in a bounded history (`HISTORY_MB`, default 256 MB, 1000 messages per subject) that is fetched on selection. Traffic and browser memory scale with what is on screen
- Per tab at most 50 msg/s per subject and 2000 msg/s in total reach the browser; the first message of a subject per second wins over repeats
- The websocket lives in a web worker that decodes MessagePack frames, keeps the tree and coalesces the feed; the main thread only renders. Message batching (100 ms), compressed frames, virtualized tree, history and branch lists
- Persistent history (`HISTORY_DB`): a SQLite copy with retention; the subject detail has a range picker (15 min to 7 days or custom) that loads messages, search results and chart series from it. A range is shown in the same view as the live feed, only with the messages of that period: the same history rail, payload viewer, trends, chart and schema
- Search over the recorded history of a subject and everything below it, by subject or payload text; export the loaded messages as JSON or CSV; replay them through the publish API with a pause and an optional subject rewrite
- Stream messages: jump to a point in time, export the page, replay it; consumers can be edited after creation
- Charts fetch their field downsampled from the server's history (up to 10 000 messages per subject) and append live values
- Stream messages can be charted too: a number in an opened message charts that field over the last 500 to 50 000 messages of the stream, for the row's subject or across all subjects, read and downsampled by the backend (`GET /api/streams/{name}/series`)
- Module switches are served from a result cache and refreshed in the background
- Measured under 5 000 subjects at 20 000 msg/s with the tree fully expanded: backend around 9 % CPU, browser main thread around 4 % busy, no long tasks, 21 MB JS heap; with the default view (first level open) 1.5 % and 6 MB
