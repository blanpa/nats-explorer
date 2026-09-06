export type AuthMethod = 'none' | 'token' | 'userpass' | 'nkey' | 'jwt';

/** Payload sent to POST /api/connect. */
export interface ConnectionConfig {
  id?: string;
  name: string;
  servers: string[];
  authMethod: AuthMethod;
  token?: string;
  user?: string;
  pass?: string;
  nkeySeed?: string;
  /** Full content of a .creds file (JWT + seed). */
  creds?: string;
  tls?: boolean;
  /** PEM: CA certificate to trust */
  tlsCa?: string;
  /** PEM: client certificate and key for mutual TLS */
  tlsCert?: string;
  tlsKey?: string;
  /** skip server certificate verification */
  tlsInsecure?: boolean;
  subscriptions?: string[];
  monitoringPort?: number;
  monitoringUrl?: string;
  /** JetStream domain to address (e.g. a leaf node's domain reachable through this server). */
  jsDomain?: string;
  /** Raw JetStream API prefix for imported APIs; takes precedence over jsDomain. */
  jsApiPrefix?: string;
  /** Optional system-account ($SYS) credentials for cluster-wide monitoring. */
  sysAuthMethod?: AuthMethod;
  sysToken?: string;
  sysUser?: string;
  sysPass?: string;
  sysNkeySeed?: string;
  sysCreds?: string;
}

/** Live state of a managed connection, pushed over the websocket. */
export interface ConnectionStatus {
  id: string;
  name: string;
  connected: boolean;
  reconnecting: boolean;
  server?: string;
  color: string;
  servers?: string[];
  subscriptions?: string[];
  jsDomain?: string;
  jsApiPrefix?: string;
  /** a system-account connection is open */
  sysAccount?: boolean;
  sysError?: string;
  lastError?: string;
  reconnects: number;
  connectedAt?: number;
}

export interface ConnectResponse {
  success: boolean;
  id: string;
  status: ConnectionStatus;
}

export interface JetStreamAccount {
  memory: number;
  storage: number;
  streams: number;
  consumers: number;
  maxMemory: number;
  maxStorage: number;
  domain?: string;
}

/** GET /api/server/:connId */
export interface ServerInfo {
  connId: string;
  serverName: string;
  serverId: string;
  version: string;
  cluster?: string;
  url: string;
  addr: string;
  maxPayload: number;
  clientId: number;
  clientIp: string;
  headers: boolean;
  authRequired: boolean;
  tlsRequired: boolean;
  rttMs: number;
  jetstream: boolean;
  jetstreamErr?: string;
  jsAccount?: JetStreamAccount | null;
  connectUrls?: string[];
  servers?: string[];
  stats: {
    inMsgs: number;
    outMsgs: number;
    inBytes: number;
    outBytes: number;
    reconnects: number;
  };
}
