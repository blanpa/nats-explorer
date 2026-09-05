import type { AuthMethod, ConnectionConfig } from 'shared';
import { uuid } from './utils';

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
  subscriptions: string[];
  sysTopics: Partial<Record<SystemTopicKey, boolean>>;
  monitoringUrl?: string;
  monitoringPort?: number;
}

export const SYSTEM_TOPICS: { key: SystemTopicKey; subject: string; label: string; description: string }[] = [
  { key: 'sys', subject: '$SYS.>', label: '$SYS', description: 'Server events, account and connection stats' },
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* quota or private mode: keep in memory only */
  }
}

/** Builds the payload for POST /api/connect, merging system subjects. */
export function toConnectionConfig(saved: SavedConnection): ConnectionConfig {
  const subs = saved.subscriptions.length ? [...saved.subscriptions] : ['>'];
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
    subscriptions: subs,
    monitoringUrl: saved.monitoringUrl || undefined,
    monitoringPort: saved.monitoringPort || undefined,
  };
}

export function serverLabel(saved: SavedConnection): string {
  return saved.servers.map(s => s.replace(/^nats:\/\//, '')).join(', ');
}
