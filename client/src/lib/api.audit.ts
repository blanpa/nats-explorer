import { request } from './api';

/** One recorded write: who changed what, and how it ended. */
export interface AuditEntry {
  time: number;
  user: string;
  role: string;
  ip: string;
  method: string;
  path: string;
  connId?: string;
  status: number;
  summary: string;
}

export interface AuditQuery {
  limit?: number;
  user?: string;
  method?: string;
  since?: number;
}

export function getAudit(q: AuditQuery = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  return request<{ entries: AuditEntry[] }>(`/audit${p.size ? `?${p}` : ''}`);
}

/** What the entry acted on, in one word for the table. */
export function objectOf(entry: AuditEntry): string {
  const parts = entry.path.replace(/^\/api\//, '').split('/');
  return parts[0] || entry.path;
}

/** Tone of the status column. */
export function statusTone(status: number): 'ok' | 'warn' | 'danger' {
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warn';
  return 'ok';
}
