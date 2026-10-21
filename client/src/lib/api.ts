import type {
  Aggregation,
  ClusterOverview,
  Topology,
  CliContextList,
  ConnectionConfig,
  ConnectionEvent,
  ConnectionStatus,
  ConnectResponse,
  ConsumerCreateInput,
  ConsumerUpdateInput,
  ConsumerInfo,
  HistoryPersistence,
  HistoryRangeResponse,
  HistoryResponse,
  HistorySeries,
  NatsMessage,
  KvBucketConfig,
  KvBucketInfo,
  KvBulkDeleteResult,
  PulledMessage,
  AckAction,
  KvEntry,
  ObjInfo,
  ObjStoreConfig,
  ObjStoreInfo,
  PublishInput,
  RequestInput,
  RunInput,
  RunResult,
  RequestReply,
  ServerInfo,
  ServiceInfo,
  ServicePing,
  ServiceStats,
  StreamConfigInput,
  StreamInfo,
  StreamMessage,
  StreamMessagesPage,
  StreamSeries,
  MatchResponse,
  StreamGaps,
} from 'shared';
import { type ApiToken, type AuthInfo, useAuth } from './auth';
import { serverUrl } from './basePath';
import type { UpdateStatus } from './updateCheck';
import { useStore } from '../store';

const BASE_URL = serverUrl('/api');

/** One thing the search found: a subject, a stream, a bucket or store, or a key or object in one. */
export interface SearchHit {
  kind: 'subject' | 'stream' | 'bucket' | 'key' | 'store' | 'object';
  name: string;
  item?: string;
  detail?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** cut at a limit or at the time budget */
  partial: boolean;
  errors: string[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    throw new ApiError(`Backend unreachable: ${(err as Error).message}`, 0);
  }
  if (res.status === 401) {
    useAuth.getState().setRequired(true);
    throw new ApiError('Authentication required', 401);
  }
  if (res.status === 403) throw new ApiError('Read-only account: this needs the admin role', 403);

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
      throw new ApiError('Unexpected non-JSON response', res.status);
    }
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error || `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const enc = encodeURIComponent;

function withConn(path: string, connId: string, params: Record<string, string | number | undefined> = {}): string {
  const q = new URLSearchParams({ connId });
  // Ad-hoc JetStream domain chosen in the UI; the backend falls back to the connection's own.
  const domain = useStore.getState().jsDomainOverride.get(connId);
  if (domain) q.set('domain', domain);
  for (const [k, val] of Object.entries(params)) if (val !== undefined && val !== '') q.set(k, String(val));
  return `${path}?${q.toString()}`;
}

export const api = {
  // Connections
  connect: (config: ConnectionConfig) => request<ConnectResponse>('/connect', { method: 'POST', ...json(config) }),
  disconnect: (connId: string) => request<{ success: boolean }>('/disconnect', { method: 'POST', ...json({ connId }) }),
  disconnectAll: () => request<{ success: boolean }>('/disconnect-all', { method: 'POST' }),
  getConnections: () => request<ConnectionStatus[]>('/connections'),
  /** Switch a live connection to new subject patterns; the feed and history start over. */
  setSubscriptions: (connId: string, subscriptions: string[]) =>
    request<{ success: boolean; status: ConnectionStatus }>(`/connections/${enc(connId)}/subscriptions`, { method: 'PUT', ...json({ subscriptions }) }),
  /** What happened to the connection's NATS connections, oldest first; kept after a disconnect. */
  connectionLog: (connId: string) => request<ConnectionEvent[]>(`/connections/${enc(connId)}/log`),
  getServerInfo: (connId: string) => request<ServerInfo>(`/server/${enc(connId)}`),
  clusterOverview: (connId: string) => request<ClusterOverview>(`/cluster/${enc(connId)}/overview`),
  /** Routes, gateways and leaf nodes, as every server reports its side of them. */
  clusterTopology: (connId: string) => request<Topology>(`/cluster/${enc(connId)}/topology`),

  // Monitoring
  getMonitoring: <T = unknown>(connId: string, endpoint: string, params: Record<string, string | number> = {}) => {
    const q = new URLSearchParams();
    for (const [k, val] of Object.entries(params)) q.set(k, String(val));
    const qs = q.toString();
    return request<T>(`/monitoring/${enc(connId)}/${endpoint}${qs ? `?${qs}` : ''}`);
  },

  // Message history recorded by the backend
  getHistory: (
    subject: string,
    opts: {
      connId?: string;
      limit?: number;
      branchLimit?: number;
      /** page backwards from this sequence, with beforeTs the time of the same message */
      before?: number;
      beforeTs?: number;
      branchBefore?: number;
      branchBeforeTs?: number;
      expr?: string;
    } = {},
  ) => {
    const q = new URLSearchParams({ subject });
    for (const [k, val] of Object.entries(opts)) if (val !== undefined) q.set(k, String(val));
    return request<HistoryResponse>(`/history?${q.toString()}`);
  },
  /**
   * Persisted messages of a subject (or below it) in a time range, newest
   * first. `beforeTs`/`beforeSeq` page backwards from a message already
   * shown; the answer's `more` says whether another page may follow.
   */
  getHistoryRange: (
    subject: string,
    opts: {
      from: number;
      to?: number;
      branch?: boolean;
      limit?: number;
      connId?: string;
      expr?: string;
      beforeTs?: number;
      beforeSeq?: number;
      /** ask for the range's total as well; worth it once, with the first page */
      count?: boolean;
    },
  ) => {
    const p = new URLSearchParams({ subject, from: String(opts.from) });
    if (opts.to) p.set('to', String(opts.to));
    if (opts.branch) p.set('branch', '1');
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.connId) p.set('connId', opts.connId);
    if (opts.expr) p.set('expr', opts.expr);
    if (opts.beforeTs) {
      p.set('beforeTs', String(opts.beforeTs));
      p.set('beforeSeq', String(opts.beforeSeq ?? 0));
    }
    if (opts.count) p.set('count', '1');
    return request<HistoryRangeResponse>(`/history/range?${p.toString()}`);
  },
  /** Newest recorded messages on a subject or below it whose subject or payload contains q. */
  searchHistory: (
    subject: string,
    q: string,
    opts: { connId?: string; limit?: number; from?: number; to?: number; expr?: string; beforeTs?: number; beforeSeq?: number } = {},
  ) => {
    const p = new URLSearchParams({ subject, q });
    for (const [k, val] of Object.entries(opts)) if (val !== undefined) p.set(k, String(val));
    return request<{ subject: string; q: string; messages: NatsMessage[]; more?: boolean }>(`/history/search?${p.toString()}`);
  },
  getSeries: (
    subject: string,
    field: string,
    opts: { connId?: string; points?: number; from?: number; to?: number; expr?: string; agg?: Aggregation } = {},
  ) => {
    const q = new URLSearchParams({ subject, field });
    for (const [k, val] of Object.entries(opts)) if (val !== undefined) q.set(k, String(val));
    return request<HistorySeries>(`/history/series?${q.toString()}`);
  },
  /** Numeric fields known from the minute aggregates, for charts over long ranges. */
  getHistoryFields: (subject: string, connId?: string) =>
    request<{ subject: string; fields: string[] }>(`/history/fields?subject=${enc(subject)}${connId ? `&connId=${enc(connId)}` : ''}`),
  clearHistory: (connId?: string) => request<{ success: boolean }>(`/history${connId ? `?connId=${enc(connId)}` : ''}`, { method: 'DELETE' }),
  /** Forgets the recorded messages of one subject, with `branch` also of everything below it. */
  clearSubjectHistory: (subject: string, opts: { branch?: boolean; connId?: string } = {}) => {
    const p = new URLSearchParams({ subject });
    if (opts.branch) p.set('branch', '1');
    if (opts.connId) p.set('connId', opts.connId);
    return request<{ success: boolean; cleared: number }>(`/history?${p.toString()}`, { method: 'DELETE' });
  },
  /** Whether the history is also written to SQLite, and how far back it is kept. */
  getHistoryPersistence: () => request<HistoryPersistence>('/history/persistence'),
  /** Switches the SQLite copy on or off; `purge` deletes the file with it. */
  setHistoryPersistence: (input: {
    enabled: boolean;
    retention?: string;
    fullText?: boolean;
    filter?: string;
    queueBytes?: number;
    maxBytes?: number;
    purge?: boolean;
  }) => request<HistoryPersistence>('/history/persistence', { method: 'PUT', ...json(input) }),

  // Publish / request
  publish: (connId: string, data: PublishInput) => request<{ success: boolean }>('/publish', { method: 'POST', ...json({ ...data, connId }) }),
  requestReply: (connId: string, data: RequestInput) => request<RequestReply>('/request', { method: 'POST', ...json({ ...data, connId }) }),
  run: (connId: string, data: RunInput) => request<RunResult>('/run', { method: 'POST', ...json({ ...data, connId }) }),

  /** The nats CLI's contexts on the machine the backend runs on, as connections. */
  listContexts: () => request<CliContextList>('/contexts'),

  // Updating the desktop app in place
  getUpdate: () => request<UpdateStatus>('/update'),
  /** Fetches the newest release, checks its signature and puts it in place; it runs from the next start. */
  startUpdate: () => request<UpdateStatus>('/update', { method: 'POST' }),
  /** A release brought along, for a machine without internet: the package, SHA256SUMS.txt and its .sig. */
  installUpdateFiles: (files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    return request<UpdateStatus>('/update/file', { method: 'POST', body: form });
  },
  /** The version the last update replaced, back in place; it runs from the next start. */
  rollbackUpdate: () => request<UpdateStatus>('/update/rollback', { method: 'POST' }),
  /** Closes the app and starts the version that was put in place. */
  restartForUpdate: () => request<{ ok: boolean }>('/update/restart', { method: 'POST' }),

  // Personal API tokens, for the scripts and the scrapers.
  listTokens: () => request<{ tokens: ApiToken[]; supported: boolean }>('/tokens'),
  /** The token itself comes back once, in the clear. */
  createToken: (name: string, role: 'admin' | 'viewer') => request<{ token: string; info: ApiToken }>('/tokens', { method: 'POST', ...json({ name, role }) }),
  deleteToken: (id: string) => request<void>(`/tokens/${enc(id)}`, { method: 'DELETE' }),

  // Streams
  listStreams: (connId: string) => request<StreamInfo[]>(withConn('/streams', connId)),
  getStream: (connId: string, name: string) => request<StreamInfo>(withConn(`/streams/${enc(name)}`, connId)),
  /** What one concrete subject runs into: which streams store it, which consumers see it. */
  matchSubject: (connId: string, subject: string) => request<MatchResponse>(withConn('/match', connId, { subject })),
  createStream: (connId: string, config: StreamConfigInput) => request<StreamInfo>(withConn('/streams', connId), { method: 'POST', ...json(config) }),
  updateStream: (connId: string, name: string, config: StreamConfigInput) =>
    request<StreamInfo>(withConn(`/streams/${enc(name)}`, connId), { method: 'PUT', ...json(config) }),
  deleteStream: (connId: string, name: string) => request<{ success: boolean }>(withConn(`/streams/${enc(name)}`, connId), { method: 'DELETE' }),
  purgeStream: (connId: string, name: string, subject?: string) =>
    request<{ success: boolean }>(withConn(`/streams/${enc(name)}/purge`, connId, { subject }), { method: 'POST' }),
  getStreamMessages: (connId: string, name: string, opts: { startSeq?: number; limit?: number; subject?: string } = {}) =>
    request<StreamMessagesPage>(withConn(`/streams/${enc(name)}/messages`, connId, opts)),
  /** The newest message on a subject of the stream, wildcards included. */
  getLastStreamMessage: (connId: string, name: string, subject: string) => request<StreamMessage>(withConn(`/streams/${enc(name)}/last`, connId, { subject })),
  /** The configuration in the server's own JSON, the one `nats stream add --config` reads. */
  getStreamConfig: (connId: string, name: string) => request<Record<string, unknown>>(withConn(`/streams/${enc(name)}/config`, connId)),
  /** The leadership of a stream's group goes to another peer. */
  stepDownStream: (connId: string, name: string) => request<{ success: boolean }>(withConn(`/streams/${enc(name)}/stepdown`, connId), { method: 'POST' }),
  /** A peer leaves a stream's group; the meta leader places a replica elsewhere. */
  removeStreamPeer: (connId: string, name: string, peer: string) =>
    request<{ success: boolean }>(withConn(`/streams/${enc(name)}/peer-remove`, connId), { method: 'POST', ...json({ peer }) }),
  stepDownConsumer: (connId: string, stream: string, consumer: string) =>
    request<{ success: boolean }>(withConn(`/streams/${enc(stream)}/consumers/${enc(consumer)}/stepdown`, connId), { method: 'POST' }),
  /** Through the system account: the server re-reads its configuration file. */
  reloadServer: (connId: string, serverId: string) =>
    request<{ success: boolean }>(`/cluster/${enc(connId)}/reload`, { method: 'POST', ...json({ serverId }) }),
  /** Through the system account: another server becomes the JetStream meta leader. */
  metaStepDown: (connId: string) => request<{ success: boolean }>(`/cluster/${enc(connId)}/meta-stepdown`, { method: 'POST' }),
  /** No more writes, no more deletes; there is no way back. */
  sealStream: (connId: string, name: string) => request<StreamInfo>(withConn(`/streams/${enc(name)}/seal`, connId), { method: 'POST' }),
  /** A zip of the stream's snapshot, laid out the way the nats CLI restores it. */
  getStreamBackupUrl: (connId: string, name: string, consumers = false) =>
    `${BASE_URL}${withConn(`/streams/${enc(name)}/backup`, connId, consumers ? { consumers: 1 } : {})}`,
  /** Recreates the stream named in the backup; it must not exist yet. */
  restoreStream: (connId: string, file: Blob) =>
    request<StreamInfo>(withConn('/streams-restore', connId), { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } }),
  /** Which sequences between first and last the stream does not have. */
  getStreamGaps: (connId: string, name: string) => request<StreamGaps>(withConn(`/streams/${enc(name)}/gaps`, connId)),
  /** The first stream sequence stored at or after a point in time. */
  getStreamSeqAt: (connId: string, name: string, timeMs: number) =>
    request<{ seq: number; timestamp: number; firstSeq: number; lastSeq: number }>(withConn(`/streams/${enc(name)}/seq`, connId, { time: timeMs })),
  getStreamSeries: (connId: string, name: string, opts: { field: string; subject?: string; last?: number; points?: number; agg?: Aggregation }) =>
    request<StreamSeries>(withConn(`/streams/${enc(name)}/series`, connId, opts)),
  deleteStreamMessage: (connId: string, stream: string, seq: number) =>
    request<{ success: boolean }>(withConn(`/streams/${enc(stream)}/messages/${seq}`, connId), { method: 'DELETE' }),

  // Consumers
  listConsumers: (connId: string, stream: string) => request<ConsumerInfo[]>(withConn(`/streams/${enc(stream)}/consumers`, connId)),
  getConsumer: (connId: string, stream: string, consumer: string) =>
    request<ConsumerInfo>(withConn(`/streams/${enc(stream)}/consumers/${enc(consumer)}`, connId)),
  createConsumer: (connId: string, stream: string, config: ConsumerCreateInput) =>
    request<ConsumerInfo>(withConn(`/streams/${enc(stream)}/consumers`, connId), { method: 'POST', ...json(config) }),
  /** Stops deliveries for a while; the consumer resumes by itself at the deadline. */
  /** The next messages of a pull consumer, not acknowledged: each carries its ack subject. */
  nextMessages: (connId: string, stream: string, consumer: string, batch: number, waitMs = 1000) =>
    request<{ messages: PulledMessage[] }>(withConn(`/streams/${enc(stream)}/consumers/${enc(consumer)}/next`, connId), {
      method: 'POST',
      ...json({ batch, waitMs }),
    }),
  /** What a client would say about a message it was handed. */
  ackMessage: (connId: string, stream: string, consumer: string, reply: string, action: AckAction, delayMs?: number) =>
    request<{ success: boolean }>(withConn(`/streams/${enc(stream)}/consumers/${enc(consumer)}/ack`, connId), {
      method: 'POST',
      ...json({ reply, action, delayMs }),
    }),
  pauseConsumer: (connId: string, stream: string, consumer: string, seconds: number) =>
    request<{ paused: boolean; pauseUntil: string }>(withConn(`/streams/${enc(stream)}/consumers/${enc(consumer)}/pause`, connId), {
      method: 'POST',
      ...json({ seconds }),
    }),
  resumeConsumer: (connId: string, stream: string, consumer: string) =>
    request<{ paused: boolean }>(withConn(`/streams/${enc(stream)}/consumers/${enc(consumer)}/resume`, connId), { method: 'POST' }),
  updateConsumer: (connId: string, stream: string, consumer: string, config: ConsumerUpdateInput) =>
    request<ConsumerInfo>(withConn(`/streams/${enc(stream)}/consumers/${enc(consumer)}`, connId), { method: 'PUT', ...json(config) }),
  deleteConsumer: (connId: string, stream: string, consumer: string) =>
    request<{ success: boolean }>(withConn(`/streams/${enc(stream)}/consumers/${enc(consumer)}`, connId), { method: 'DELETE' }),

  // KV
  listKvBuckets: (connId: string) => request<KvBucketInfo[]>(withConn('/kv', connId)),
  createKvBucket: (connId: string, config: KvBucketConfig) => request<{ success: boolean }>(withConn('/kv', connId), { method: 'POST', ...json(config) }),
  /** The bucket's limits, TTL, replicas, sources and metadata; storage and history stay. */
  updateKvBucket: (connId: string, bucket: string, config: Partial<KvBucketConfig>) =>
    request<KvBucketInfo>(withConn(`/kv/${enc(bucket)}`, connId), { method: 'PUT', ...json(config) }),
  /** Many keys at once; what failed is named back. */
  deleteKvKeys: (connId: string, bucket: string, keys: string[], purge = false) =>
    request<KvBulkDeleteResult>(withConn(`/kv-bulk-delete/${enc(bucket)}`, connId), { method: 'POST', ...json({ keys, purge }) }),
  deleteKvBucket: (connId: string, bucket: string) => request<{ success: boolean }>(withConn(`/kv/${enc(bucket)}`, connId), { method: 'DELETE' }),
  listKvKeys: (connId: string, bucket: string) => request<string[]>(withConn(`/kv/${enc(bucket)}`, connId)),
  getKvEntry: (connId: string, bucket: string, key: string) => request<KvEntry>(withConn(`/kv/${enc(bucket)}/${enc(key)}`, connId)),
  /** With a revision the put only goes through if nobody wrote in between; 0 says the key must be new. */
  putKvEntry: (connId: string, bucket: string, key: string, value: string, revision?: number) =>
    request<{ success: boolean; revision: number }>(withConn(`/kv/${enc(bucket)}/${enc(key)}`, connId), {
      method: 'PUT',
      ...json(revision === undefined ? { value } : { value, revision }),
    }),
  deleteKvEntry: (connId: string, bucket: string, key: string) =>
    request<{ success: boolean }>(withConn(`/kv/${enc(bucket)}/${enc(key)}`, connId), { method: 'DELETE' }),
  purgeKvKey: (connId: string, bucket: string, key: string) =>
    request<{ success: boolean }>(withConn(`/kv/${enc(bucket)}/${enc(key)}/purge`, connId), { method: 'POST' }),

  // Object store
  listObjectStores: (connId: string) => request<ObjStoreInfo[]>(withConn('/objectstore', connId)),
  createObjectStore: (connId: string, config: ObjStoreConfig) =>
    request<{ success: boolean }>(withConn('/objectstore', connId), { method: 'POST', ...json(config) }),
  deleteObjectStore: (connId: string, store: string) => request<{ success: boolean }>(withConn(`/objectstore/${enc(store)}`, connId), { method: 'DELETE' }),
  listObjects: (connId: string, store: string) => request<ObjInfo[]>(withConn(`/objectstore/${enc(store)}`, connId)),
  /** No more uploads, no more deletes, for good. */
  sealObjectStore: (connId: string, store: string) => request<{ success: boolean }>(withConn(`/objectstore-seal/${enc(store)}`, connId), { method: 'POST' }),
  deleteObjects: (connId: string, store: string, names: string[]) =>
    request<{ deleted: number; failed: Record<string, string> }>(withConn(`/objectstore-bulk-delete/${enc(store)}`, connId), {
      method: 'POST',
      ...json({ names }),
    }),
  deleteObject: (connId: string, store: string, name: string) =>
    request<{ success: boolean }>(withConn(`/objectstore/${enc(store)}/${enc(name)}`, connId), { method: 'DELETE' }),
  /** Direct download link; the session cookie authenticates it. */
  getObjectUrl: (connId: string, store: string, name: string) => `${BASE_URL}${withConn(`/objectstore/${enc(store)}/${enc(name)}`, connId)}`,
  authInfo: () => request<AuthInfo>('/auth'),
  /**
   * Streams the file body directly; no base64 round-trip. Through an
   * XMLHttpRequest, because fetch does not tell how much of a body went out:
   * `onProgress` hears the bytes sent, and `signal` cancels the upload.
   */
  putObject: (
    connId: string,
    store: string,
    file: File,
    opts: { description?: string; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {},
  ) =>
    new Promise<{ success: boolean; size: number; chunks: number }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `${BASE_URL}${withConn(`/objectstore/${enc(store)}/${enc(file.name)}`, connId, { description: opts.description })}`);
      // Always raw: the server reads an application/json body as the base64
      // envelope, so a .json file sent as its own type would be stored empty.
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      if (opts.onProgress) {
        const report = opts.onProgress;
        xhr.upload.onprogress = e => report(e.loaded, e.lengthComputable ? e.total : file.size);
      }
      xhr.onerror = () => reject(new ApiError('Backend unreachable: the upload was cut off', 0));
      xhr.onabort = () => reject(new ApiError('Upload cancelled', 0));
      xhr.onload = () => {
        if (xhr.status === 401) {
          useAuth.getState().setRequired(true);
          reject(new ApiError('Authentication required', 401));
          return;
        }
        if (xhr.status === 403) {
          reject(new ApiError('Read-only account: this needs the admin role', 403));
          return;
        }
        let data: unknown = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          reject(new ApiError(xhr.status >= 400 ? `${xhr.status} ${xhr.statusText}` : 'Unexpected non-JSON response', xhr.status));
          return;
        }
        if (xhr.status >= 400) {
          reject(new ApiError((data as { error?: string } | null)?.error || `${xhr.status} ${xhr.statusText}`, xhr.status));
          return;
        }
        resolve(data as { success: boolean; size: number; chunks: number });
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(new ApiError('Upload cancelled', 0));
          return;
        }
        opts.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(file);
    }),

  /** Subjects, streams, buckets, keys, stores and objects whose name holds `q`, for the command palette. */
  search: (connId: string, q: string) => request<SearchResult>(withConn('/search', connId, { q })),

  // Services
  discoverServices: (connId: string) => request<ServiceInfo[]>(withConn('/services', connId)),
  getServiceStats: (connId: string) => request<ServiceStats[]>(withConn('/services/stats', connId)),
  pingServices: (connId: string) => request<ServicePing[]>(withConn('/services/ping', connId)),
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * JetStream calls to a domain nobody serves cannot fail fast: the explorer's
 * own `>` subscription answers every subject, so NATS never reports "no
 * responders" and the call runs into its deadline. Say so instead of
 * showing a bare "context deadline exceeded".
 */
export function describeJsError(error: string, domain?: string): string {
  if (/deadline exceeded|timeout/i.test(error)) {
    return domain
      ? `No answer from JetStream domain "${domain}". Check the domain name and whether that JetStream is reachable through this server.`
      : 'No answer from JetStream within the time limit. Is JetStream enabled on this server or account?';
  }
  return error;
}
