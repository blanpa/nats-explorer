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
- The subject header says when the last message arrived and how long ago, which is what says a subject has gone quiet; the status bar says how long the connection has been up
- Keyboard: `/` focuses the filter of the current module, Escape clears it, `j`/`k` walk the subject tree, arrow keys expand and collapse
- The explorer and the history rail are dragged to width by the handle on their edge; a double-click resets, and both widths are remembered
- Watch several subjects at once: Ctrl/Cmd-click adds subjects to the selection; the detail pane then shows the latest value and rate of each and one list of everything arriving on any of them, newest first
- Subjects split by `.` into a virtualized tree with the message count and rate of each subject and each branch. A collapsed branch also says how many subjects with messages are under it
- The quote icon in the header puts the last payload next to each subject. It is off by default, and off it is not sent over the socket at all
- Filter with several words; system roots (`$JS`, `$KV`, `$SYS`, `_INBOX`, …) are hidden behind a toggle
- Selecting a branch shows the recent messages of everything below it
- Large subject spaces cost what is on screen, not what the server sees: see [Performance](#performance)

## What matches a subject

The overflow menu of a subject asks the question a wildcard makes hard: what would one concrete message on it actually run into? The answer is one dialog -- the connection's subscriptions that cover it, the streams that store it and through which of their own patterns, the consumers that would see it and how many filter it out, the alert rules that watch it, and the pinned schema that judges it. The subject can be edited in place, so it answers for one that has never been sent.

`*` covers one token and `>` the rest; stream subjects overlap; a consumer filter one level too deep is invisible until nothing arrives. `GET /api/match?subject=` answers the JetStream half for scripts.

## Bookmarks

The star in the subject header keeps a subject, with an optional name, group and note. Bookmarks appear as their own panel above the tree and select their subject even when it is filtered out or has not sent anything yet; the note shows under the subject header. Selecting a subject that way, or from an alert or a message list, opens the branches above it in the tree. They travel with the other settings, so with file storage they follow the user to another browser.

## Clearing the history

The eraser in the subject header forgets the recorded messages of that subject. On a branch it takes everything below it as well, and the confirmation says which of the two is about to happen. The rest of the recorded history stays. Both the memory and the persistent copy are cleared, so a time range does not bring the messages back, and the subject leaves the tree until it sends again. The eraser in the Subjects pane header clears everything at once, after a confirmation: every recorded message of every connection, in memory and on disk, and the subject tree with them. A tree row that says three thousand messages with nothing behind it says less than an empty tree; subjects come back as they send again.

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

## History and time ranges

The rail beside a payload is the recorded history of that subject, newest first, and it pages backwards as it is scrolled: a thousand to begin with, then 500 at a time from memory and 2000 at a time from the persistent copy, up to 10 000 in the tab. It reads past the edge of memory -- memory holds the newest few thousand messages of a subject, and a byte budget shared with every other subject cuts a busy one to far fewer, 2 083 of 14 336 on a running demo -- so the paging carries on in the database, across server restarts included. "No older messages" is said only about messages that were never recorded.

Scrolling back holds the payload viewer on the message being read instead of letting every arrival replace it; the badge says so, and scrolling back to the newest, or one click, follows the live tail again. The rail shows from the first message, not the second: it is also the way to what was recorded before the tab was opened.

The list below a branch, the search results and the merged list of several watched subjects page the same way, 200 at a time. Each has its own cursor: a node's own messages run out at a different point than everything below it, and a search at yet another.

### Time ranges

With a persistent history the subject detail carries a range picker: 15 minutes to 30 days back, a custom window to the second, or a window dragged out of a chart. A range is the same view as the live feed with the messages of that period -- the same rail, payload viewer, trends, chart and schema -- and the search, the schema and an export follow it.

Picking a range shows the range's own total from the first answer, counted on the server from the index without reading a payload, and the view then fills itself in up to 50 000 messages without being scrolled. A figure that climbs while it is being read is worse than none; with a payload filter the total is left out, because only reading the messages can say how many it keeps.

Once there is a window, three buttons next to the presets widen it by double around its middle, or step it half a window earlier or later, never past now.

## Persistent history

A SQLite copy of every message alongside the one in memory: on by default in the desktop app, a setting (the gear at the bottom of the rail) everywhere the server has a directory of its own, and pinned by `HISTORY_DB`. It is what time ranges, the full-text search and the long charts read.

Connecting restores the recorded subjects into the tree with their message count and their newest message, so a restart does not begin on an empty namespace and the payload filter works on those subjects right away. The count is what the database still holds, so it follows the retention. The rest stays on disk: the live view of a restored subject is empty until it sends again, and the range picker reads the recorded ones.

Writing to disk is the slower path. With the full-text index it sustains roughly 25 000 msg/s, without it four times that (`go test -bench BenchmarkTuning ./internal/history/`). A burst above that rate is buffered in memory -- 64 MB by default, a few hundred thousand small messages -- and only what does not fit is dropped, counted, and named in the status bar. Sustained overload cannot be buffered away: a queue that keeps growing postpones the loss and pays for it in memory. When something did not reach the disk the status bar says so instead of only turning a size amber, and the setting behind it lists what to change, cheapest first: narrow what is written, switch the full-text index off, raise the buffer. Remedies already in place are left out of the list.

**Retention** can be turned off entirely ("Forever (never delete)", or `HISTORY_RETENTION=0`): nothing is deleted by age and the database grows until the disk is full. It is the right answer for a recording made on purpose, and the one setting here that waiting cannot undo, so the hint under it says so instead of the usual "older messages are deleted once a minute". The range picker then offers "All" alongside the reaching-back presets, because with no retention there is no sensible upper one to stop at.

**What is written** can be narrowed by a CEL expression ("Only write messages matching", or `HISTORY_FILTER`) over the same variables as a payload filter. It is the only one of the three remedies that lowers the write rate itself rather than making the writer faster: on a firehose where a handful of subjects matter, the disk copy stops being the bottleneck instead of merely coping with it. It never narrows the live view -- the feed and the tree show everything that arrives -- and what it leaves out is counted apart from what was lost. A filter over the subject costs about 250 ns per message, one that reaches into the payload about 3 µs.

## Export and replay

An export covers what is selected, not what has been scrolled to: with a time range active it pages the rest in from the server before writing the file, up to 200 000 messages, and says so if it had to stop there. The menu names the scope rather than a count.

Six shapes, because what an export is for decides its shape:

| Shape | What it is for |
|:-- |:-- |
| **JSON** | One array, for reading |
| **NDJSON** | One message per line with the payload as a document -- what `jq`, DuckDB's `read_json_auto()`, ClickHouse and BigQuery read without a second parse |
| **CSV** | The payload whole in one cell, headers included |
| **CSV, one column per field** | `payload.<path>` and `header.<name>` spread out, the one a spreadsheet or pandas can use as it is |
| **Payloads only** | The bodies alone |
| **Replay script** | For the `nats` CLI |

{% raw %}The replay script quotes for the shell, carries the headers, sends binary payloads through base64 and stdin, and escapes `{{` as `{{"{{"}}` -- `nats pub` expands Go templates in the body, so a payload holding `{{Count}}` would otherwise arrive as `1`.{% endraw %} The loaded messages can also be replayed straight through the publish API, with a pause and an optional subject rewrite.

## Alerts

<img src="{{ '/screenshots/alerts-dark.png' | relative_url }}" alt="The Alerts module: what is firing, the rules behind it and the log" loading="lazy">

A rule watches a subject pattern for a condition: an expression that holds, a subject that stopped sending, or both. It can be written from the Alerts module, or straight from the subject it is about -- the overflow menu of a subject opens the dialog with the pattern and the name already filled in, so only the condition is left to say. The backend evaluates the rules on the message path, so they keep working while no browser is open, and an optional webhook receives a JSON POST on every state change.

The Alerts module lists what is firing right now, the rules with the number of subjects each one matches, and a log of state changes. A rule can be tried against the recorded messages before it is saved, which answers "how many of my messages would this match" without waiting. The rail badge counts the active alerts from every module, and a new warning or critical alert raises a toast.

## Message detail

- JSON, raw and hex views; history of the last messages; diff to the previous message
- Headers with their meaning: the ones NATS sets explain themselves -- the deduplication key, the publish preconditions, the rollups, where a sourced message came from -- and a `Nats-Msg-Id` seen twice among the messages on screen is marked
- Payload decoders: rules per subject pattern decode MessagePack, Protocol Buffers (paste the `.proto`, name the message type) or Avro (paste the schema) into the JSON tree; the rules are kept with the other settings
- Click a number in the JSON to chart it over time as line, area, step, bars or dots
- Click a point in that chart to see the message behind it: the value decides which one, so a peak opens the message that caused it. Points older than what the browser holds are fetched from the persistent history
- The other way round too: the message currently shown is marked in the chart, and its value and time head the chart instead of the newest ones. Picking another message in the history rail moves the marker with it
- Publish drawer with templates and recent sends

### Charts

A chart is fetched from the server already reduced -- up to 10 000 messages per subject, from memory and, where memory falls short, from the database -- and the live values that arrived after it are appended.

- Several fields at once: clicking a second number adds it rather than replacing the first, up to six. Separate charts by default, each with its own axis; "One chart" overlays them, scaling fields of different units to their own range with the axis in per cent while the values above it stay real
- Seven reductions per bucket, chosen next to the chart: min/max (the default, and the only one that never hides an outlier), avg, min, max, sum, count and rate per second. Rate is what makes a counter readable -- a field like `parts_produced` is a staircase whose slope is the number anyone wanted; a decrease reads as no change, so a restart does not spike the chart
- Drag across a chart to zoom into that stretch of time. The drag sets the time range, so the history, the search, the schema and an export follow it, and the server reduces the field over the shorter window -- zooming in really does show more, it does not stretch what was already drawn. "Custom" then opens on the window that is showing, so a rough drag can be corrected to the second
- Over more than six hours the points come from minute aggregates the writer keeps alongside the messages -- minimum, maximum and average per minute and numeric field -- so a week is a few hundred points instead of a few hundred thousand, and the chart says "per minute". The same reduction is applied there, so the meaning does not change with the range. Unless those aggregates span a single minute: then there is nothing to reduce, and the messages are read instead, with their real times

## Schema

Every subject carries a derived schema under its payload: which fields the JSON messages contain, their types with counts, how often each field appears, its value range or enumeration, and an example. Nobody maintains it; it is read from the recorded messages and refreshes every ten seconds.

When the newer half of the messages looks different from the older half, the section is marked with drift and the changed fields say what happened: a type that changed, a field that is no longer sent, or one that just appeared. That catches a device or gateway whose output silently changed, which otherwise only surfaces when something downstream breaks. Drift needs at least five messages per half, so an optional field or an integer that becomes a decimal is never reported as a change.

Once a schema is pinned, every message in the history rail and in a branch list carries its verdict: a green edge while it matches, a red one when it breaks the reference, and what differs on hover. A subject with nothing pinned shows nothing -- "no reference" is not "matches the reference".

**Pin as expected** turns the description into a reference. A pinned schema belongs to a subject pattern and is checked against every message from then on: `valid` and `violations` become available in every CEL expression, so `!valid` narrows the subject tree, the history, a time range and the search to the messages that do not match, and the same expression is a complete alert rule. The panel says how many of the sampled messages fail and jumps to them, and the publish form warns before sending a payload that would not match. Types and required fields are enforced; observed ranges are not, because a range from 200 samples is not a rule, and an unknown field only counts when the schema was pinned strict.

**Copy as** puts the schema on the clipboard in a form another project can use: a **JSON Schema** (draft 2020-12) for validators and code generators, or a **TypeScript interface** to paste into a consumer. Fields present in every message become `required`, the others optional; a string field with a small set of observed values becomes an enumeration; observed ranges and how often a field appeared are written as descriptions, not as constraints -- a range seen in 200 messages is not a rule. Both carry a header saying what they were derived from. `GET /api/schema?subject=…` returns the same data as raw JSON for scripts.

## JetStream

<img src="{{ '/screenshots/jetstream-light.png' | relative_url }}" alt="A stream with its limits, configuration and placement, in the light theme" loading="lazy">

- Streams: list, create, edit, purge, delete; page through messages from the newest sequence; live tail; delete single messages
- Consumers: list, create, delete, state, and pause/resume -- a paused consumer delivers nothing until its deadline and resumes by itself (NATS 2.11)
- KV/Object backing streams (`KV_*`, `OBJ_*`) hidden by default behind a toggle
- Jump to a point in time in a stream, export the page, replay it
- Sequence gaps: the overview names the sequences between first and last that the stream does not have, as runs. A delete, a purge up to a sequence or a per-subject limit leaves a hole, and a consumer walking past it has not missed anything -- which is the thing that is hard to tell from outside
- The message table's seq, time, subject and size columns are dragged to width by the line between the headers, which runs the length of the table while it is being aimed at; a double-click restores the default and the widths are remembered
- The Seq header sorts the page newest first or oldest first
- A number in an opened message charts that field over the last 500 to 50 000 messages of the stream, for the row's subject or across all subjects, read and downsampled by the backend (`GET /api/streams/{name}/series`)
- **JetStream domains**: a connection can carry a `jsDomain` or API prefix (leaf nodes behind a hub and vice versa), and the JetStream, KV and Object Store panes have a domain switch for ad-hoc changes

### Consumers and replication

A consumer row carries its lag, the distance between the stream head and what the consumer has delivered, with a warning arrow when the backlog grew over the last samples. Opening a row shows pending and ack-pending over time, sampled on every refresh of the list.

It also names what the consumer is waiting for. An ack floor cannot move past a message that is never acknowledged, so a stuck consumer is nearly always stuck on the oldest of its unacknowledged messages and everything else waits behind that one. The row names it -- sequence, subject, payload, how long ago it was stored -- and lists the window behind it. A filtered consumer sees only the subjects it takes.

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
- **Repeated runs**: send a template up to 10 000 times with parallel senders and an optional pause; read sent/ok/errors, throughput and the first replies
- Variables replaced per message in subject, payload and headers: {% raw %}`{{i}}`{% endraw %} (counter), {% raw %}`{{ts}}`{% endraw %} (unix milliseconds), {% raw %}`{{uuid}}`{% endraw %}, {% raw %}`{{rand:MIN-MAX}}`{% endraw %}

A run reports its latency as minimum, average, p50, p95, p99 and maximum, plus a histogram of where the replies landed. The shape matters: a summary hides a run where most replies are fast and a few sit on the timeout.

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
- Every pattern can be removed, `>` included: a connection then receives nothing and says so, which is what publishing, JetStream or KV work needs on a busy cluster. Opening a connection without naming any pattern still subscribes to `>`
- The subject filter completes as you type: the rest of the term stands faintly behind the cursor and Tab (or the right arrow) takes it, one segment at a time for a dotted path. There is no dropdown -- the tree is the list of matches, and it stays visible
- Changing the subscriptions keeps everything already collected, including the subjects of the pattern that went. The tree is what the connection has received, not what it is listening to at this instant: a subject that arrived is a fact, and unsubscribing only stops the next message -- its rate falls to zero and its messages stay readable. Emptying the tree is its own action, and asks first
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

The design is that a tab pays for what is on screen, not for what the server sees.

- The browser only receives the messages of the subject or branch it looks at. The backend records every message in a bounded history (`HISTORY_MB`, 256 MB by default, at most 10 000 messages per subject) that a tab fetches on selection, so traffic and browser memory scale with the selection rather than with the traffic
- Per tab at most 50 msg/s per subject and 2000 msg/s in total reach the browser; the first message of a subject per second wins over repeats
- The websocket lives in a web worker that decodes the MessagePack frames, keeps the tree and coalesces the feed; the main thread only renders. Message batching (100 ms), compressed frames, and virtualized tree, history and branch lists
- The server keeps the subject tree and sends a tab only the branches it has expanded, as a flat delta of what changed; the filter runs on the server over the whole namespace. Module switches are served from a result cache and refreshed in the background

Measured on a development machine, eight cores:

| | |
|:-- |:-- |
| 5 000 subjects at 20 000 msg/s, tree fully expanded | backend ~9 % CPU, browser main thread ~4 % busy, no long tasks, 21 MB JS heap |
| the same with the default view (first level open) | 1.5 % and 6 MB |
| 5 000 000 messages at 340 000 msg/s over 5 000 subjects | all counted and recorded, at about one of eight cores -- the limit in that test was the publisher, not the explorer |
| the SQLite copy | ~25 000 msg/s with the full-text index, four times that without it |
