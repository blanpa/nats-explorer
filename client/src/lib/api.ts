const BASE_URL = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function withConnId(path: string, connId: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}connId=${encodeURIComponent(connId)}`;
}

export const api = {
  // Connection management
  connect: (config: any) => request('/connect', { method: 'POST', body: JSON.stringify(config) }),
  disconnect: (connId: string) => request('/disconnect', { method: 'POST', body: JSON.stringify({ connId }) }),
  disconnectAll: () => request('/disconnect-all', { method: 'POST' }),
  getConnections: () => request<any[]>('/connections'),
  status: (connId?: string) => request(connId ? `/status?connId=${connId}` : '/status'),

  // Cluster
  getClusterInfo: (connId: string) => request(`/cluster/${connId}`),

  // Monitoring
  getMonitoring: (connId: string, endpoint: string) => request(`/monitoring/${connId}/${endpoint}`),

  // Publish (include connId in body)
  publish: (connId: string, data: { subject: string; payload: string; headers?: Record<string, string[]> }) =>
    request('/publish', { method: 'POST', body: JSON.stringify({ ...data, connId }) }),

  requestReply: (connId: string, data: { subject: string; payload: string; timeout?: number }) =>
    request('/request', { method: 'POST', body: JSON.stringify({ ...data, connId }) }),

  // Streams
  listStreams: (connId: string) => request<any[]>(withConnId('/streams', connId)),
  createStream: (connId: string, config: any) => request(withConnId('/streams', connId), { method: 'POST', body: JSON.stringify(config) }),
  getStream: (connId: string, name: string) => request(withConnId(`/streams/${name}`, connId)),
  updateStream: (connId: string, name: string, config: any) => request(withConnId(`/streams/${name}`, connId), { method: 'PUT', body: JSON.stringify(config) }),
  deleteStream: (connId: string, name: string) => request(withConnId(`/streams/${name}`, connId), { method: 'DELETE' }),
  purgeStream: (connId: string, name: string) => request(withConnId(`/streams/${name}/purge`, connId), { method: 'POST' }),
  getStreamMessages: (connId: string, name: string, startSeq?: number, limit?: number) =>
    request(withConnId(`/streams/${name}/messages?startSeq=${startSeq || 1}&limit=${limit || 50}`, connId)),

  // Consumers
  listConsumers: (connId: string, stream: string) => request<any[]>(withConnId(`/streams/${stream}/consumers`, connId)),
  createConsumer: (connId: string, stream: string, config: any) =>
    request(withConnId(`/streams/${stream}/consumers`, connId), { method: 'POST', body: JSON.stringify(config) }),
  deleteConsumer: (connId: string, stream: string, consumer: string) =>
    request(withConnId(`/streams/${stream}/consumers/${consumer}`, connId), { method: 'DELETE' }),

  // KV
  listKvBuckets: (connId: string) => request<any[]>(withConnId('/kv', connId)),
  createKvBucket: (connId: string, config: any) => request(withConnId('/kv', connId), { method: 'POST', body: JSON.stringify(config) }),
  listKvKeys: (connId: string, bucket: string) => request<string[]>(withConnId(`/kv/${bucket}`, connId)),
  getKvEntry: (connId: string, bucket: string, key: string) => request(withConnId(`/kv/${bucket}/${key}`, connId)),
  putKvEntry: (connId: string, bucket: string, key: string, value: string) =>
    request(withConnId(`/kv/${bucket}/${key}`, connId), { method: 'PUT', body: JSON.stringify({ value }) }),
  deleteKvEntry: (connId: string, bucket: string, key: string) =>
    request(withConnId(`/kv/${bucket}/${key}`, connId), { method: 'DELETE' }),
  deleteKvBucket: (connId: string, bucket: string) =>
    request(withConnId(`/kv/${bucket}`, connId), { method: 'DELETE' }),

  // Object Store
  listObjectStores: (connId: string) => request<any[]>(withConnId('/objectstore', connId)),
  createObjectStore: (connId: string, config: any) => request(withConnId('/objectstore', connId), { method: 'POST', body: JSON.stringify(config) }),
  listObjects: (connId: string, store: string) => request<any[]>(withConnId(`/objectstore/${store}`, connId)),
  deleteObject: (connId: string, store: string, name: string) =>
    request(withConnId(`/objectstore/${store}/${name}`, connId), { method: 'DELETE' }),
  getObjectUrl: (connId: string, store: string, name: string) => `${BASE_URL}/objectstore/${store}/${name}?connId=${connId}`,

  // Services
  discoverServices: (connId: string) => request<any[]>(withConnId('/services', connId)),
  getServiceStats: (connId: string) => request<any[]>(withConnId('/services/stats', connId)),
  pingServices: (connId: string) => request<any[]>(withConnId('/services/ping', connId)),

  // Stream message delete
  deleteStreamMessage: (connId: string, stream: string, seq: number) =>
    request(withConnId(`/streams/${stream}/messages/${seq}`, connId), { method: 'DELETE' }),

  // Object upload
  putObject: (connId: string, store: string, name: string, data: string, description?: string) =>
    request(withConnId(`/objectstore/${store}/${name}`, connId), {
      method: 'PUT',
      body: JSON.stringify({ data, description }),
    }),

  // KV extras
  purgeKvKey: (connId: string, bucket: string, key: string) =>
    request(withConnId(`/kv/${bucket}/${key}/purge`, connId), { method: 'POST' }),
  getKvBucketStatus: (connId: string, bucket: string) =>
    request(withConnId(`/kv/${bucket}/status`, connId)),

  // Consumer info
  getConsumer: (connId: string, stream: string, consumer: string) =>
    request(withConnId(`/streams/${stream}/consumers/${consumer}`, connId)),
};
