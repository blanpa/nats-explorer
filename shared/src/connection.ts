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
  /** do the TLS handshake before the server's INFO (servers with handshake_first) */
  tlsFirst?: boolean;
  subscriptions?: string[];
  monitoringPort?: number;
  monitoringUrl?: string;
  /** JetStream domain to address (e.g. a leaf node's domain reachable through this server). */
  jsDomain?: string;
  /** Raw JetStream API prefix for imported APIs; takes precedence over jsDomain. */
  jsApiPrefix?: string;
  /** Through a bastion host: one SSH session, every dial of the NATS client through it. */
  ssh?: SshConfig;
  /** Optional system-account ($SYS) credentials for cluster-wide monitoring. */
  sysAuthMethod?: AuthMethod;
  sysToken?: string;
  sysUser?: string;
  sysPass?: string;
  sysNkeySeed?: string;
  sysCreds?: string;
}

/** The bastion a connection goes through. */
export interface SshConfig {
  host: string;
  port?: number;
  user: string;
  password?: string;
  /** PEM of a private key, with its passphrase where it has one */
  privateKey?: string;
  passphrase?: string;
  /** the bastion's public key pinned, as a known_hosts line; empty accepts and reports it */
  hostKey?: string;
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
  /** the last time the connection was lost; the reason is the server's when it could be asked (system account or monitoring port) */
  lastDrop?: { at: number; reason: string; slowConsumer?: boolean /** the subscriptions' connection was lost, the API's stayed up */; live?: boolean };
  /** times the server closed the connection as a slow consumer: the subscriptions match more than reaches the explorer in time */
  slowConsumerDrops?: number;
  /** the subscriptions run on a connection of their own; it is reconnecting, it reconnected this often, or why there is none and they share the API's */
  liveReconnecting?: boolean;
  liveReconnects?: number;
  liveError?: string;
  /** the live connection dropped liveFlaps times in a row soon after connecting and waits this long before it tries again, as the server sent it */
  livePauseMs?: number;
  /** livePauseMs turned into a time of the browser's clock when the status arrived (store) */
  livePausedUntil?: number;
  liveFlaps?: number;
  /** the NATS connections open for it right now: API, subscriptions (live), system account */
  links?: ConnectionLink[];
  /** an imported support bundle: recorded messages, nothing can be sent */
  bundle?: boolean;
  connectedAt?: number;
  /** goes through a bastion; the host key seen when none was pinned, for pinning it */
  ssh?: boolean;
  sshHostKey?: string;
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

/** A nats CLI context, mapped onto a connection; GET /api/contexts. */
export interface CliContext {
  name: string;
  description?: string;
  servers: string[];
  authMethod: AuthMethod;
  token?: string;
  user?: string;
  pass?: string;
  nkeySeed?: string;
  creds?: string;
  tls?: boolean;
  tlsCa?: string;
  tlsCert?: string;
  tlsKey?: string;
  tlsFirst?: boolean;
  jsDomain?: string;
  jsApiPrefix?: string;
  /** what could not be read, e.g. a credentials file that is not there */
  problems?: string[];
}

export interface CliContextList {
  /** false on a server without NATS_CONTEXTS_DIR; the desktop app always reads them */
  available: boolean;
  dir?: string;
  contexts: CliContext[];
}

/**
 * One thing that happened to one of a connection's NATS connections, from
 * the connection log (`GET /api/connections/{id}/log`, oldest first).
 */
export interface ConnectionEvent {
  at: number;
  /** api, live (the subscriptions') or system */
  link: 'api' | 'live' | 'system';
  /**
   * reason is the server's word on a drop, asked after the reconnect;
   * retrying a failed reconnect attempt (the first, a new error, every 30th);
   * lameduck the server going down; discovered the cluster's servers learnt
   */
  kind: 'connected' | 'disconnected' | 'retrying' | 'reconnected' | 'reason' | 'error' | 'lameduck' | 'discovered' | 'closed' | 'failed';
  server?: string;
  cid?: number;
  detail?: string;
}

/** One of the NATS connections behind a connection. */
export interface ConnectionLink {
  name: 'api' | 'live' | 'system';
  connected: boolean;
  reconnecting: boolean;
  server?: string;
  cid?: number;
  /** when the current connection was made */
  since?: number;
  reconnects: number;
}
