import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { PayloadType } from 'shared';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ---------------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------------ */

export function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || Number.isNaN(bytes)) return '–';
  if (bytes < 0) return 'unlimited';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  const value = bytes / Math.pow(k, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${sizes[i]}`;
}

export function formatNumber(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return '–';
  if (n < 0) return 'unlimited';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** Formats a nanosecond duration such as JetStream max_age. */
export function formatDurationNs(ns: number | undefined | null): string {
  if (ns == null) return '–';
  if (ns <= 0) return 'unlimited';
  return formatDurationMs(ns / 1e6);
}

export function formatDurationMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(2) : Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export function formatTime(ts: number | string | Date, withMs = true): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '–';
  const base = d.toLocaleTimeString(undefined, { hour12: false });
  return withMs ? `${base}.${d.getMilliseconds().toString().padStart(3, '0')}` : base;
}

export function formatDateTime(ts: number | string | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '–';
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString(undefined, { hour12: false })}`;
}

export function formatRelative(ts: number | string | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  const diff = Date.now() - d.getTime();
  if (Number.isNaN(diff)) return '–';
  if (diff < 1000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/* ---------------------------------------------------------------------------
 * Payload helpers
 * ------------------------------------------------------------------------ */

export function tryParseJson(payload: string): unknown | undefined {
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

export function prettyJson(payload: string): string {
  const parsed = tryParseJson(payload);
  return parsed === undefined ? payload : JSON.stringify(parsed, null, 2);
}

/** Decodes a wire payload into raw bytes (binary payloads are base64). */
export function payloadBytes(payload: string, type: PayloadType): Uint8Array {
  if (type === 'binary') {
    try {
      const bin = atob(payload);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return new TextEncoder().encode(payload);
    }
  }
  return new TextEncoder().encode(payload);
}

export function hexDump(bytes: Uint8Array, maxBytes = 4096): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, maxBytes);
  for (let i = 0; i < n; i += 16) {
    const slice = bytes.subarray(i, Math.min(i + 16, n));
    const hex = Array.from(slice, b => b.toString(16).padStart(2, '0'));
    const hexStr = `${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}`.padEnd(49);
    const ascii = Array.from(slice, b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hexStr} |${ascii}|`);
  }
  if (bytes.length > maxBytes) lines.push(`… ${bytes.length - maxBytes} more bytes`);
  return lines.join('\n');
}

/** Short one-line preview of a payload for lists and tree rows. */
export function previewPayload(payload: string, type: PayloadType, max = 60): { text: string; tone: 'str' | 'num' | 'bool' | 'null' | 'obj' | 'bin' } {
  if (type === 'binary') return { text: `binary`, tone: 'bin' };
  if (type === 'json') {
    const parsed = tryParseJson(payload);
    if (typeof parsed === 'number') return { text: String(parsed), tone: 'num' };
    if (typeof parsed === 'boolean') return { text: String(parsed), tone: 'bool' };
    if (parsed === null) return { text: 'null', tone: 'null' };
    if (typeof parsed === 'string') return { text: JSON.stringify(truncate(parsed, max)), tone: 'str' };
    if (parsed !== undefined) return { text: truncate(JSON.stringify(parsed), max), tone: 'obj' };
  }
  return { text: truncate(payload.replace(/\s+/g, ' '), max), tone: 'str' };
}

/** Extracts a numeric value from a JSON payload by dotted path. */
export function extractNumber(payload: string, path: string): number | null {
  const root = tryParseJson(payload);
  if (root === undefined) return null;
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Parses "a, b\nc" style lists into trimmed non-empty strings. */
export function parseList(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}
