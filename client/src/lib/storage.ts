import { useAuth } from './auth';

/**
 * Where UI state lives. In the browser everything is in localStorage. The
 * desktop app (and a server started with STORAGE_DIR) keeps the same `ne.*`
 * entries in a settings file on the backend: at start-up they are copied into
 * localStorage, and every write goes to both. Reads therefore stay synchronous
 * everywhere.
 */
export interface AppInfo {
  mode: 'server' | 'desktop';
  storage: 'browser' | 'file';
  secrets?: 'keyring' | 'file';
  configDir?: string;
  version: string;
}

export const appInfo: AppInfo = { mode: 'server', storage: 'browser', version: 'dev' };

/** Minimal Storage surface so the helpers can be unit-tested without a DOM. */
export interface StorageLike {
  length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const PREFIX = 'ne.';

/** All `ne.*` entries of a storage, parsed; entries that are not JSON are skipped. */
export function collectLocal(storage: StorageLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    const raw = storage.getItem(k);
    if (raw === null) continue;
    try {
      out[k] = JSON.parse(raw);
    } catch {
      /* legacy non-JSON value: not synced */
    }
  }
  return out;
}

/** Writes backend entries into the storage the UI reads from. */
export function seedLocal(storage: StorageLike, entries: Record<string, unknown>): number {
  let n = 0;
  for (const [k, v] of Object.entries(entries)) {
    if (!k.startsWith(PREFIX)) continue;
    storage.setItem(k, JSON.stringify(v));
    n++;
  }
  return n;
}

let remote = false;
const pending = new Map<string, unknown>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let onError: ((message: string) => void) | null = null;

export function setPersistErrorHandler(fn: (message: string) => void) {
  onError = fn;
}

function headers(): Record<string, string> {
  const token = useAuth.getState().token;
  return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function flush() {
  flushTimer = null;
  const batch = [...pending];
  pending.clear();
  for (const [key, value] of batch) {
    try {
      const res = await fetch(`/api/settings/${encodeURIComponent(key)}`, { method: 'PUT', headers: headers(), body: JSON.stringify(value) });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    } catch (err) {
      onError?.(`Could not save ${key}: ${(err as Error).message}`);
    }
  }
}

/** Stores a JSON value under a `ne.*` key: localStorage now, the backend file shortly after (when applicable). */
export function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
  if (!remote) return;
  pending.set(key, value);
  if (!flushTimer) flushTimer = setTimeout(flush, 250);
}

/**
 * Asks the backend what kind of installation this is and, for file storage,
 * copies its entries into localStorage before the UI renders. Returns false
 * when the backend wants a token first (the caller retries after login).
 */
export async function bootstrapStorage(): Promise<boolean> {
  try {
    const res = await fetch('/api/app');
    if (!res.ok) return true;
    Object.assign(appInfo, await res.json());
  } catch {
    return true;
  }
  if (appInfo.storage !== 'file') return true;
  const res = await fetch('/api/settings', { headers: headers() }).catch(() => null);
  if (!res) return true;
  if (res.status === 401) return false;
  if (!res.ok) return true;
  const { entries } = (await res.json()) as { entries: Record<string, unknown> };
  remote = true;
  if (Object.keys(entries).length === 0) {
    // First start with file storage: keep whatever this browser profile already had.
    const local = collectLocal(localStorage);
    for (const [k, v] of Object.entries(local)) persist(k, v);
    return true;
  }
  seedLocal(localStorage, entries);
  return true;
}
