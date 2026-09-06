import type {
  ClusterOverview,
  ConnectionConfig,
  ConnectionStatus,
  ConnectResponse,
  ConsumerCreateInput,
  ConsumerInfo,
  KvBucketConfig,
  KvBucketInfo,
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
  StreamMessagesPage,
} from 'shared';
import { useAuth, withToken } from './auth';
import { useStore } from '../store';

const BASE_URL = '/api';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res: Response;
  const token = useAuth.getState().token;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  getServerInfo: (connId: string) => request<ServerInfo>(`/server/${enc(connId)}`),
  clusterOverview: (connId: string) => request<ClusterOverview>(`/cluster/${enc(connId)}/overview`),

  // Monitoring
  getMonitoring: <T = unknown>(connId: string, endpoint: string, params: Record<string, string | number> = {}) => {
    const q = new URLSearchParams();
    for (const [k, val] of Object.entries(params)) q.set(k, String(val));
    const qs = q.toString();
    return request<T>(`/monitoring/${enc(connId)}/${endpoint}${qs ? `?${qs}` : ''}`);
  },

  // Publish / request
  publish: (connId: string, data: PublishInput) => request<{ success: boolean }>('/publish', { method: 'POST', ...json({ ...data, connId }) }),
  requestReply: (connId: string, data: RequestInput) => request<RequestReply>('/request', { method: 'POST', ...json({ ...data, connId }) }),
  run: (connId: string, data: RunInput) => request<RunResult>('/run', { method: 'POST', ...json({ ...data, connId }) }),

  // Streams
  listStreams: (connId: string) => request<StreamInfo[]>(withConn('/streams', connId)),
  getStream: (connId: string, name: string) => request<StreamInfo>(withConn(`/streams/${enc(name)}`, connId)),
  createStream: (connId: string, config: StreamConfigInput) => request<StreamInfo>(withConn('/streams', connId), { method: 'POST', ...json(config) }),
  updateStream: (connId: string, name: string, config: StreamConfigInput) =>
    request<StreamInfo>(withConn(`/streams/${enc(name)}`, connId), { method: 'PUT', ...json(config) }),
  deleteStream: (connId: string, name: string) => request<{ success: boolean }>(withConn(`/streams/${enc(name)}`, connId), { method: 'DELETE' }),
  purgeStream: (connId: string, name: string, subject?: string) =>
    request<{ success: boolean }>(withConn(`/streams/${enc(name)}/purge`, connId, { subject }), { method: 'POST' }),
  getStreamMessages: (connId: string, name: string, opts: { startSeq?: number; limit?: number } = {}) =>
    request<StreamMessagesPage>(withConn(`/streams/${enc(name)}/messages`, connId, opts)),
  deleteStreamMessage: (connId: string, stream: string, seq: number) =>
    request<{ success: boolean }>(withConn(`/streams/${enc(stream)}/messages/${seq}`, connId), { method: 'DELETE' }),

  // Consumers
  listConsumers: (connId: string, stream: string) => request<ConsumerInfo[]>(withConn(`/streams/${enc(stream)}/consumers`, connId)),
  getConsumer: (connId: string, stream: string, consumer: string) =>
    request<ConsumerInfo>(withConn(`/streams/${enc(stream)}/consumers/${enc(consumer)}`, connId)),
  createConsumer: (connId: string, stream: string, config: ConsumerCreateInput) =>
    request<ConsumerInfo>(withConn(`/streams/${enc(stream)}/consumers`, connId), { method: 'POST', ...json(config) }),
  deleteConsumer: (connId: string, stream: string, consumer: string) =>
    request<{ success: boolean }>(withConn(`/streams/${enc(stream)}/consumers/${enc(consumer)}`, connId), { method: 'DELETE' }),

  // KV
  listKvBuckets: (connId: string) => request<KvBucketInfo[]>(withConn('/kv', connId)),
  createKvBucket: (connId: string, config: KvBucketConfig) => request<{ success: boolean }>(withConn('/kv', connId), { method: 'POST', ...json(config) }),
  deleteKvBucket: (connId: string, bucket: string) => request<{ success: boolean }>(withConn(`/kv/${enc(bucket)}`, connId), { method: 'DELETE' }),
  listKvKeys: (connId: string, bucket: string) => request<string[]>(withConn(`/kv/${enc(bucket)}`, connId)),
  getKvEntry: (connId: string, bucket: string, key: string) => request<KvEntry>(withConn(`/kv/${enc(bucket)}/${enc(key)}`, connId)),
  putKvEntry: (connId: string, bucket: string, key: string, value: string) =>
    request<{ success: boolean; revision: number }>(withConn(`/kv/${enc(bucket)}/${enc(key)}`, connId), { method: 'PUT', ...json({ value }) }),
  deleteKvEntry: (connId: string, bucket: string, key: string) =>
    request<{ success: boolean }>(withConn(`/kv/${enc(bucket)}/${enc(key)}`, connId), { method: 'DELETE' }),
  purgeKvKey: (connId: string, bucket: string, key: string) =>
    request<{ success: boolean }>(withConn(`/kv/${enc(bucket)}/${enc(key)}/purge`, connId), { method: 'POST' }),

  // Object store
  listObjectStores: (connId: string) => request<ObjStoreInfo[]>(withConn('/objectstore', connId)),
  createObjectStore: (connId: string, config: ObjStoreConfig) =>
    request<{ success: boolean }>(withConn('/objectstore', connId), { method: 'POST', ...json(config) }),
  deleteObjectStore: (connId: string, store: string) =>
    request<{ success: boolean }>(withConn(`/objectstore/${enc(store)}`, connId), { method: 'DELETE' }),
  listObjects: (connId: string, store: string) => request<ObjInfo[]>(withConn(`/objectstore/${enc(store)}`, connId)),
  deleteObject: (connId: string, store: string, name: string) =>
    request<{ success: boolean }>(withConn(`/objectstore/${enc(store)}/${enc(name)}`, connId), { method: 'DELETE' }),
  /** Direct download link; carries the token as a query parameter because anchors cannot set headers. */
  getObjectUrl: (connId: string, store: string, name: string) => withToken(`${BASE_URL}${withConn(`/objectstore/${enc(store)}/${enc(name)}`, connId)}`),
  authInfo: () => request<{ required: boolean }>('/auth'),
  /** Streams the file body directly; no base64 round-trip. */
  putObject: (connId: string, store: string, file: File, description?: string) =>
    request<{ success: boolean; size: number; chunks: number }>(withConn(`/objectstore/${enc(store)}/${enc(file.name)}`, connId, { description }), {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    }),

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
