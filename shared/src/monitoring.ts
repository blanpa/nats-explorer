/**
 * Loose typings for the nats-server HTTP monitoring endpoints. Only the
 * fields the UI reads are declared; everything else is passed through.
 */
export interface Varz {
  server_id: string;
  server_name: string;
  version: string;
  go: string;
  host: string;
  port: number;
  cores: number;
  max_procs?: number;
  cpu: number;
  mem: number;
  uptime: string;
  now: string;
  start: string;
  connections: number;
  total_connections: number;
  subscriptions: number;
  slow_consumers: number;
  in_msgs: number;
  out_msgs: number;
  in_bytes: number;
  out_bytes: number;
  routes?: number;
  remotes?: number;
  leafnodes?: number;
  max_payload: number;
  max_connections?: number;
  jetstream?: unknown;
  [key: string]: unknown;
}

export interface Jsz {
  memory: number;
  storage: number;
  streams: number;
  consumers: number;
  messages: number;
  bytes: number;
  config?: { max_memory: number; max_storage: number; store_dir?: string };
  api?: { total: number; errors: number };
  [key: string]: unknown;
}

export interface ConnzConnection {
  cid: number;
  name?: string;
  ip: string;
  port: number;
  start: string;
  uptime: string;
  idle: string;
  rtt?: string;
  subscriptions: number;
  in_msgs: number;
  out_msgs: number;
  in_bytes: number;
  out_bytes: number;
  lang?: string;
  version?: string;
  [key: string]: unknown;
}

export interface Connz {
  num_connections: number;
  total: number;
  connections: ConnzConnection[];
  [key: string]: unknown;
}

export interface Subsz {
  num_subscriptions: number;
  num_cache: number;
  num_inserts: number;
  num_removes: number;
  num_matches: number;
  cache_hit_rate: number;
  max_fanout: number;
  avg_fanout: number;
  [key: string]: unknown;
}

export interface Healthz {
  status: string;
  error?: string;
}

export interface RouteInfo {
  rid: number;
  remote_id: string;
  remote_name?: string;
  ip: string;
  port: number;
  rtt?: string;
  in_msgs?: number;
  out_msgs?: number;
  in_bytes?: number;
  out_bytes?: number;
  pending_size?: number;
  subscriptions?: number;
  [key: string]: unknown;
}

export interface Routez {
  num_routes: number;
  routes: RouteInfo[];
  [key: string]: unknown;
}

export interface LeafInfo {
  name?: string;
  account?: string;
  is_spoke?: boolean;
  ip: string;
  port: number;
  rtt?: string;
  in_msgs?: number;
  out_msgs?: number;
  in_bytes?: number;
  out_bytes?: number;
  subscriptions?: number;
  [key: string]: unknown;
}

/** /leafz */
export interface Leafz {
  leafnodes: number;
  leafs: LeafInfo[];
  [key: string]: unknown;
}

/** GET /api/cluster/:connId/overview */
export interface ClusterPeer {
  name: string;
  current: boolean;
  offline: boolean;
  active: number;
  lag: number;
}

export interface ClusterServerRow {
  name: string;
  id: string;
  host: string;
  version: string;
  cluster: string;
  jetstream: boolean;
  metaLeader: boolean;
  start?: string;
  cpu: number;
  cores: number;
  mem: number;
  connections: number;
  subscriptions: number;
  slowConsumers: number;
  inMsgs: number;
  outMsgs: number;
  inBytes: number;
  outBytes: number;
  routes: number;
  gateways: number;
  js?: { memory: number; storage: number; streams: number; consumers: number; api: { total: number; errors: number } };
}

export interface ClusterStreamRow {
  account: string;
  name: string;
  messages: number;
  bytes: number;
  consumers: number;
  replicas: number;
  storage: string;
  cluster?: string;
  leader?: string;
  peers: ClusterPeer[];
  created?: string;
}

export interface ClusterOverview {
  source: 'system' | 'monitoring';
  servers: ClusterServerRow[];
  meta: { name: string; leader: string; cluster_size: number; replicas: ClusterPeer[] } | null;
  streams: ClusterStreamRow[];
  errors: string[];
}
