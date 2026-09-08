import type { NatsMessage, StreamMessage } from 'shared';
import { api } from './api';

export interface ReplayOptions {
  /** pause between publishes */
  intervalMs: number;
  /** rewrite the subject: messages whose subject starts with `from` get `to` instead */
  rewrite?: { from: string; to: string };
}

export interface ReplayProgress {
  sent: number;
  total: number;
  failed: number;
  lastError?: string;
}

const rewriteSubject = (subject: string, rw?: ReplayOptions['rewrite']) =>
  rw?.from && subject.startsWith(rw.from) ? rw.to + subject.slice(rw.from.length) : subject;

/**
 * Publishes messages again through the backend, oldest first, one after the
 * other. Binary payloads are skipped: the publish API carries text. Returns
 * when done or when `signal` aborts.
 */
export async function replayMessages(
  connId: string,
  messages: (NatsMessage | StreamMessage)[],
  opts: ReplayOptions,
  onProgress: (p: ReplayProgress) => void,
  signal?: AbortSignal,
): Promise<ReplayProgress> {
  const ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const progress: ReplayProgress = { sent: 0, total: ordered.length, failed: 0 };
  for (const m of ordered) {
    if (signal?.aborted) break;
    if (m.payloadType === 'binary') {
      progress.failed++;
      progress.lastError = 'binary payloads cannot be replayed';
    } else {
      try {
        await api.publish(connId, { subject: rewriteSubject(m.subject, opts.rewrite), payload: m.payload, headers: m.headers });
        progress.sent++;
      } catch (err) {
        progress.failed++;
        progress.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    onProgress({ ...progress });
    if (opts.intervalMs > 0) await new Promise(r => setTimeout(r, opts.intervalMs));
  }
  return progress;
}
