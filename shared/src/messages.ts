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
  sequence?: number;
  /** Set client-side to remember which connection delivered the message. */
  connId?: string;
}

/**
 * One subject in the tree feed. The server sends a flat list and the browser
 * rebuilds the hierarchy. Keys are short because large trees are re-sent
 * every few hundred milliseconds.
 */
export interface SubjectEntry {
  /** full subject */
  s: string;
  /** messages seen on exactly this subject */
  n: number;
  /** messages per second over the last 10 s */
  r: number;
  /** preview of the last payload, truncated server-side; absent for binary */
  p?: string;
  pt?: PayloadType;
  /** timestamp of the last message (ms) */
  ts?: number;
  /** size of the last payload in bytes */
  sz?: number;
}

export interface SubscriptionStats {
  received: number;
  dropped: number;
  subjects: number;
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
  latency?: { min: number; avg: number; p50: number; p95: number; max: number };
  replies: RunReply[];
  errorSamples: { i: number; error: string }[];
  errorCounts: Record<string, number>;
  stopped: boolean;
}
