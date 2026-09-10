export type PayloadType = 'string' | 'json' | 'binary';

/** A message as delivered to the browser. Binary payloads are base64. */
export interface NatsMessage {
  subject: string;
  payload: string;
  payloadType: PayloadType;
  headers?: Record<string, string[]>;
  timestamp: number;
  reply?: string;
  size: number;
  /** arrival number on its connection; unique per connection, used to merge feed and history */
  sequence?: number;
  /** connection that delivered the message; set by the history API, added client-side for the live feed */
  connId?: string;
}

/**
 * One node of the subject tree. The server keeps the hierarchy and sends a
 * tab only the nodes visible in its view (expanded branches, or the paths of
 * filter matches); the browser merges them across connections. Keys are
 * short because the feed is the largest thing on the socket.
 */
export interface SubjectEntry {
  /** full subject */
  s: string;
  /** messages seen on exactly this subject */
  n: number;
  /** messages per second over the last 10 s */
  r: number;
  /** messages in the whole subtree, this node included */
  t: number;
  /** rate of the whole subtree */
  tr: number;
  /** number of children on the server; a collapsed branch shows a chevron from this */
  c?: number;
  /** subjects with at least one message in the subtree, this node included */
  sc?: number;
  /** preview of the last payload, truncated server-side; absent for binary */
  p?: string;
  pt?: PayloadType;
  /** timestamp of the last message (ms) */
  ts?: number;
  /** size of the last payload in bytes */
  sz?: number;
}

/** Counters of one connection's subscription, pushed once a second as a `stats` event. */
export interface SubscriptionStats {
  /** messages received on the server side since connect */
  received: number;
  /** messages of a focused subject that did not fit the tab's feed budget; they are still in the history */
  throttled: number;
  subjects: number;
  /** messages per second received, averaged over the last seconds */
  rate: number;
  /** size of the server-side message history for this connection, and of the SQLite copy when enabled */
  history: {
    messages: number;
    bytes: number;
    subjects: number;
    db?: HistoryDbStats;
  };
  /** counters per subscribed pattern */
  patterns?: { pattern: string; received: number; subjects: number; rate: number }[];
}

/** GET /api/history/series: a numeric JSON field over the recorded history, downsampled. */
export interface HistorySeries {
  subject: string;
  field: string;
  /** [timestamp ms, value] in time order; every bucket keeps its min and max */
  points: [number, number][];
  /** messages that carried the field */
  samples: number;
  /** sequence of the newest message considered; live messages after it can be appended */
  last: number;
  /** "rollup" when the points are minute aggregates instead of messages */
  source?: 'rollup';
}

/** GET /api/history: what the server recorded for a subject and the branch below it. */
export interface HistoryResponse {
  subject: string;
  /** messages on exactly the subject, oldest first; each carries its connId */
  messages: NatsMessage[];
  /** newest messages on subjects below it, newest first */
  branch: NatsMessage[];
  /** the store held more before the cursor, so another page backwards may follow */
  more?: boolean;
  /** the same for the branch list, which merges every subject below the node */
  branchMore?: boolean;
}

/** GET /api/history/range: persisted messages of a time range, newest first. */
export interface HistoryRangeResponse {
  subject: string;
  from: number;
  to: number;
  messages: NatsMessage[];
  /** another page before the oldest message returned may follow */
  more?: boolean;
}

/** Size of the SQLite copy of the history. */
export interface HistoryDbStats {
  path: string;
  messages: number;
  bytes: number;
  /** timestamp of the oldest message kept, unix ms; 0 when empty */
  oldest: number;
  /** messages not persisted because the writer fell behind */
  dropped: number;
  /** messages the persist filter left out on purpose */
  filtered: number;
  /** bytes waiting to be written, out of `queueBytes` */
  queued: number;
  /** how much of a burst the writer buffers before it drops */
  queueBytes: number;
  retention: string;
}

/** GET/PUT /api/history/persistence: the SQLite copy of the history as a setting. */
export interface HistoryPersistence {
  /** false when this installation has nowhere to put the file; `reason` says why */
  supported: boolean;
  reason?: string;
  /** HISTORY_DB decides: the UI reports the state but cannot change it */
  managed: boolean;
  enabled: boolean;
  path?: string;
  /** how far back the database is kept, as a Go duration ("72h0m0s") */
  retention: string;
  /** the word index behind the search over the persistent history */
  fullText?: boolean;
  /** CEL expression deciding what is written to disk; empty keeps everything */
  filter?: string;
  /** how much of a burst the writer buffers, and what it may be raised to */
  queueBytes?: number;
  maxQueueBytes?: number;
  db?: HistoryDbStats;
}

export interface PublishInput {
  subject: string;
  payload: string;
  headers?: Record<string, string[]>;
}

export interface RequestInput extends PublishInput {
  timeout?: number;
}

export interface RequestReply {
  subject: string;
  payload: string;
  payloadType: PayloadType;
  reply?: string;
  size: number;
  durationMs: number;
  headers?: Record<string, string[]>;
}

/** Repeated publish/request. Subject, payload and header values may use {{i}}, {{ts}}, {{uuid}}, {{rand:MIN-MAX}}. */
export interface RunInput extends PublishInput {
  mode: 'publish' | 'request';
  count: number;
  concurrency?: number;
  intervalMs?: number;
  timeout?: number;
}

export interface RunReply {
  i: number;
  subject: string;
  payload: string;
  payloadType: PayloadType;
  size: number;
  durationMs: number;
}

export interface RunResult {
  mode: 'publish' | 'request';
  sent: number;
  ok: number;
  errors: number;
  durationMs: number;
  perSecond: number;
  latency?: {
    min: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    /** replies per bucket; `le` is the upper bound in ms, 0 means slower than the last bound */
    histogram?: { le: number; count: number }[];
  };
  replies: RunReply[];
  errorSamples: { i: number; error: string }[];
  errorCounts: Record<string, number>;
  stopped: boolean;
}
