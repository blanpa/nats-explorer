import type { AuthMethod, ConnectionConfig } from 'shared';
import { uuid } from './utils';
import { persist } from './storage';

export type SystemTopicKey = 'sys' | 'js' | 'kv' | 'srv';

export interface SavedConnection {
  id: string;
  name: string;
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
  tlsInsecure?: boolean;
  /** TLS before the server's INFO, for servers with handshake_first */
  tlsFirst?: boolean;
  subscriptions: string[];
  sysTopics: Partial<Record<SystemTopicKey, boolean>>;
  /** Opened by the backend when it starts (file storage only). */
  autoConnect?: boolean;
  monitoringUrl?: string;
  monitoringPort?: number;
  jsDomain?: string;
  jsApiPrefix?: string;
  sysAuthMethod?: AuthMethod;
  sysToken?: string;
  sysUser?: string;
  sysPass?: string;
  sysNkeySeed?: string;
  sysCreds?: string;
}

export const SYSTEM_TOPICS: { key: SystemTopicKey; subject: string; label: string; description: string }[] = [
  { key: 'sys', subject: '$SYS.>', label: '$SYS', description: 'Server events, account and connection stats (system account only)' },
  { key: 'js', subject: '$JS.>', label: '$JS', description: 'JetStream API and advisories' },
  { key: 'kv', subject: '$KV.>', label: '$KV', description: 'Key-Value change notifications' },
  { key: 'srv', subject: '$SRV.>', label: '$SRV', description: 'Micro service discovery and ping' },
];

const STORAGE_KEY = 'ne.connections.v2';
const LEGACY_KEY = 'nats-explorer-connections';

export function newSavedConnection(partial: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: uuid(),
    name: '',
    servers: ['nats://localhost:4222'],
    authMethod: 'none',
    subscriptions: ['>'],
    sysTopics: {},
    ...partial,
  };
}

interface LegacySaved {
  name?: string;
  host?: string;
  port?: string | number;
  authMethod?: AuthMethod;
  subscriptions?: string[];
  token?: string;
  user?: string;
  pass?: string;
  nkeySeed?: string;
  creds?: string;
  tls?: boolean;
  monitoringPort?: number;
  sysTopics?: Partial<Record<SystemTopicKey, boolean>>;
}

export function migrateLegacy(items: LegacySaved[]): SavedConnection[] {
  return items.map(l =>
    newSavedConnection({
      name: l.name || `${l.host || 'localhost'}:${l.port || 4222}`,
      servers: [`nats://${l.host || 'localhost'}:${l.port || 4222}`],
      authMethod: l.authMethod || 'none',
      token: l.token,
      user: l.user,
      pass: l.pass,
      nkeySeed: l.nkeySeed,
      creds: l.creds,
      tls: l.tls,
      subscriptions: l.subscriptions?.length ? l.subscriptions : ['>'],
      sysTopics: l.sysTopics || {},
      monitoringPort: l.monitoringPort,
    }),
  );
}

export function loadSavedConnections(): SavedConnection[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedConnection[];
      return parsed.map(p => ({ ...newSavedConnection(), ...p, id: p.id || uuid() }));
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const migrated = migrateLegacy(JSON.parse(legacy));
      persistSavedConnections(migrated);
      return migrated;
    }
  } catch {
    /* fall through */
  }
  return [newSavedConnection({ name: 'Local', servers: ['nats://localhost:4222'] })];
}

export function persistSavedConnections(items: SavedConnection[]) {
  persist(STORAGE_KEY, items);
}

/** Builds the payload for POST /api/connect, merging system subjects. */
export function toConnectionConfig(saved: SavedConnection): ConnectionConfig {
  // Kept as it is: a connection whose patterns were all removed reconnects
  // listening to nothing, rather than to everything.
  const subs = [...saved.subscriptions];
  for (const st of SYSTEM_TOPICS) {
    if (saved.sysTopics?.[st.key] && !subs.includes(st.subject)) subs.push(st.subject);
  }
  return {
    id: saved.id,
    name: saved.name || saved.servers[0],
    servers: saved.servers,
    authMethod: saved.authMethod,
    token: saved.authMethod === 'token' ? saved.token : undefined,
    user: saved.authMethod === 'userpass' ? saved.user : undefined,
    pass: saved.authMethod === 'userpass' ? saved.pass : undefined,
    nkeySeed: saved.authMethod === 'nkey' ? saved.nkeySeed : undefined,
    creds: saved.authMethod === 'jwt' ? saved.creds : undefined,
    tls: saved.tls,
    tlsCa: saved.tls ? saved.tlsCa?.trim() || undefined : undefined,
    tlsCert: saved.tls ? saved.tlsCert?.trim() || undefined : undefined,
    tlsKey: saved.tls ? saved.tlsKey?.trim() || undefined : undefined,
    tlsInsecure: saved.tls ? saved.tlsInsecure || undefined : undefined,
    tlsFirst: saved.tls ? saved.tlsFirst || undefined : undefined,
    subscriptions: subs,
    monitoringUrl: saved.monitoringUrl || undefined,
    monitoringPort: saved.monitoringPort || undefined,
    jsDomain: saved.jsDomain?.trim() || undefined,
    jsApiPrefix: saved.jsApiPrefix?.trim() || undefined,
    ...systemAccountConfig(saved),
  };
}

export function serverLabel(saved: SavedConnection): string {
  return saved.servers.map(s => s.replace(/^nats:\/\//, '')).join(', ');
}

/** Only the credentials matching the chosen system-account auth method are sent. */
function systemAccountConfig(saved: SavedConnection): Partial<ConnectionConfig> {
  const m = saved.sysAuthMethod;
  if (!m || m === 'none') return {};
  return {
    sysAuthMethod: m,
    sysToken: m === 'token' ? saved.sysToken : undefined,
    sysUser: m === 'userpass' ? saved.sysUser : undefined,
    sysPass: m === 'userpass' ? saved.sysPass : undefined,
    sysNkeySeed: m === 'nkey' ? saved.sysNkeySeed : undefined,
    sysCreds: m === 'jwt' ? saved.sysCreds : undefined,
  };
}
