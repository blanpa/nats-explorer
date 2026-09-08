import { create } from 'zustand';

export type AuthMode = 'none' | 'token' | 'users';
export type Role = 'admin' | 'viewer' | '';

export interface AuthInfo {
  mode: AuthMode;
  authenticated: boolean;
  user: string;
  role: Role;
}

interface AuthState extends AuthInfo {
  /** the backend answered 401: a login is needed before anything else works */
  required: boolean;
  /** first /api/auth answer arrived */
  ready: boolean;
  /** re-reads who the cookie belongs to */
  refresh: () => Promise<void>;
  login: (body: { user: string; password: string } | { token: string }) => Promise<void>;
  logout: () => Promise<void>;
  setRequired: (b: boolean) => void;
}

async function fetchAuth(): Promise<AuthInfo> {
  const res = await fetch('/api/auth');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as AuthInfo;
}

/**
 * Who the browser is, as far as the backend is concerned. The session lives
 * in an HttpOnly cookie the backend sets on login, so no request and no
 * websocket URL carries a credential.
 */
export const useAuth = create<AuthState>((set, get) => ({
  mode: 'none',
  authenticated: true,
  user: '',
  role: 'admin',
  required: false,
  ready: false,
  refresh: async () => {
    try {
      const info = await fetchAuth();
      set({ ...info, ready: true, required: !info.authenticated });
    } catch {
      set({ ready: true });
    }
  },
  login: async body => {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `${res.status} ${res.statusText}`);
    }
    const id = (await res.json()) as { user: string; role: Role };
    set({ authenticated: true, required: false, user: id.user, role: id.role });
  },
  logout: async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => undefined);
    set({ authenticated: false, required: get().mode !== 'none', user: '', role: '' });
  },
  setRequired: b => set({ required: b, ...(b ? { authenticated: false } : {}) }),
}));

/** Whether the current account may change things: publish, create, delete, edit settings. */
export function canWrite(s: Pick<AuthState, 'mode' | 'role'>): boolean {
  return s.mode === 'none' || s.role === 'admin';
}

export function useCanWrite(): boolean {
  return useAuth(canWrite);
}
