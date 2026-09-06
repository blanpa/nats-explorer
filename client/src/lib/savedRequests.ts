import { uuid } from './utils';
import { persist } from './storage';

export type RequestMode = 'publish' | 'request';

export interface HeaderPair {
  key: string;
  value: string;
}

/** A reusable publish/request template, stored in this browser. */
export interface SavedRequest {
  id: string;
  name: string;
  mode: RequestMode;
  subject: string;
  payload: string;
  headers: HeaderPair[];
  timeout?: number;
  count?: number;
  concurrency?: number;
  intervalMs?: number;
  updatedAt: number;
}

const STORAGE_KEY = 'ne.requests.v1';
const COLLECTION_MARKER = 'nats-explorer-requests';

export function loadSavedRequests(): SavedRequest[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseCollection(raw) : [];
  } catch {
    return [];
  }
}

export function persistSavedRequests(items: SavedRequest[]): void {
  persist(STORAGE_KEY, items);
}

export function newSavedRequest(partial: Partial<SavedRequest>): SavedRequest {
  return {
    id: uuid(),
    name: '',
    mode: 'publish',
    subject: '',
    payload: '',
    headers: [],
    updatedAt: Date.now(),
    ...partial,
  };
}

/** Export format: a small envelope so files are recognisable, items inside. */
export function serializeCollection(items: SavedRequest[]): string {
  return JSON.stringify({ format: COLLECTION_MARKER, version: 1, exportedAt: new Date().toISOString(), items }, null, 2);
}

/**
 * Accepts the export envelope or a bare array and returns only well-formed
 * items (unknown fields dropped, ids regenerated when missing).
 */
export function parseCollection(text: string): SavedRequest[] {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : [];
  const out: SavedRequest[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.subject !== 'string') continue;
    const headers = Array.isArray(r.headers)
      ? (r.headers as unknown[])
          .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
          .map(h => ({ key: String(h.key ?? ''), value: String(h.value ?? '') }))
          .filter(h => h.key)
      : [];
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id : uuid(),
      name: typeof r.name === 'string' ? r.name : '',
      mode: r.mode === 'request' ? 'request' : 'publish',
      subject: r.subject,
      payload: typeof r.payload === 'string' ? r.payload : '',
      headers,
      timeout: num(r.timeout),
      count: num(r.count),
      concurrency: num(r.concurrency),
      intervalMs: num(r.intervalMs),
      updatedAt: num(r.updatedAt) ?? Date.now(),
    });
  }
  return out;
}

/** Editable form state shared by the publish drawer and the Requests module. */
export interface RequestDraft {
  mode: RequestMode;
  subject: string;
  payload: string;
  headers: HeaderPair[];
  timeout: number;
  count: number;
  concurrency: number;
  intervalMs: number;
}

export function emptyDraft(subject = ''): RequestDraft {
  return { mode: 'publish', subject, payload: '', headers: [], timeout: 5000, count: 1, concurrency: 1, intervalMs: 0 };
}

export function draftFromSaved(t: SavedRequest): RequestDraft {
  return {
    mode: t.mode,
    subject: t.subject,
    payload: t.payload,
    headers: t.headers.map(h => ({ ...h })),
    timeout: t.timeout ?? 5000,
    count: t.count ?? 1,
    concurrency: t.concurrency ?? 1,
    intervalMs: t.intervalMs ?? 0,
  };
}

/** Applies a draft to a template (kept fields: id, name). */
export function savedFromDraft(d: RequestDraft, base: Pick<SavedRequest, 'id' | 'name'>): SavedRequest {
  const repeated = d.count > 1;
  return {
    id: base.id,
    name: base.name,
    mode: d.mode,
    subject: d.subject.trim(),
    payload: d.payload,
    headers: d.headers.filter(h => h.key.trim()),
    timeout: d.mode === 'request' ? d.timeout : undefined,
    count: repeated ? d.count : undefined,
    concurrency: repeated ? d.concurrency : undefined,
    intervalMs: repeated && d.intervalMs > 0 ? d.intervalMs : undefined,
    updatedAt: Date.now(),
  };
}

/** True when the draft differs from what the template stores. */
export function draftDiffers(d: RequestDraft, t: SavedRequest): boolean {
  const a = savedFromDraft(d, t);
  const norm = (x: SavedRequest) => JSON.stringify([x.mode, x.subject, x.payload, x.headers, x.timeout ?? null, x.count ?? null, x.concurrency ?? null, x.intervalMs ?? null]);
  return norm(a) !== norm({ ...t, headers: t.headers.filter(h => h.key.trim()) });
}
