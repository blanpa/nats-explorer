import { request } from './api';

/** What an exported bundle says about itself. */
export interface BundleManifest {
  format: number;
  createdAt: number;
  explorerVersion: string;
  connection: { id: string; name: string; servers?: string[]; subscriptions?: string[]; jsDomain?: string };
  from?: number;
  to?: number;
  subject?: string;
  messages: number;
  subjects: number;
  errors?: string[];
}

export interface OpenedBundle {
  manifest: BundleManifest;
  /** raw monitoring endpoints as they were at export time */
  server?: Record<string, unknown>;
  streams?: { name: string; subjects?: string[]; messages: number; bytes: number; consumers: { name: string; pending: number }[] }[];
  kv?: { bucket: string; values: number; bytes: number; history: number }[];
}

export interface BundleRange {
  connId: string;
  /** unix ms; 0 exports what is in memory */
  from?: number;
  to?: number;
  subject?: string;
  limit?: number;
}

/**
 * The download URL of an export. A plain link works because the session
 * cookie authenticates it, and the backend streams the zip.
 */
export function bundleUrl({ connId, from, to, subject, limit }: BundleRange): string {
  const p = new URLSearchParams({ connId });
  if (from) p.set('from', String(from));
  if (to) p.set('to', String(to));
  if (subject?.trim()) p.set('subject', subject.trim());
  if (limit) p.set('limit', String(limit));
  return `/api/bundle?${p.toString()}`;
}

export const bundleApi = {
  open: async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/bundle/import', { method: 'POST', body: form });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as { id: string; name: string; messages: number; manifest: BundleManifest };
  },
  get: (id: string) => request<OpenedBundle>(`/bundle/${encodeURIComponent(id)}`),
  close: (id: string) => request<void>(`/bundle/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
