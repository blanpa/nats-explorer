import { create } from 'zustand';

const KEY = 'ne.token';

/** API token, kept in sessionStorage so it does not outlive the tab. */
export function readToken(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeToken(token: string) {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

interface AuthState {
  /** the backend answered 401, or /api/auth said a token is required */
  required: boolean;
  token: string;
  setToken: (t: string) => void;
  setRequired: (b: boolean) => void;
}

export const useAuth = create<AuthState>(set => ({
  required: false,
  token: readToken(),
  setToken: t => {
    writeToken(t);
    set({ token: t, required: false });
  },
  setRequired: b => set({ required: b }),
}));

/** Appends the token as a query parameter for URLs that cannot carry headers. */
export function withToken(url: string): string {
  const token = useAuth.getState().token;
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}
