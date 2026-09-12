import type { NatsMessage } from 'shared';
import type { LatencyBucket } from '../components/requests/LatencyHistogram';
import { tryParseJson } from './utils';

/**
 * How long one step of a chain takes.
 *
 * `orders.created` and `orders.paid` are two subjects, and the time between
 * them is the number the business asks about and nobody measures: the
 * request/reply latency of a service is visible, the hop between two
 * published messages is not. Both messages carry the same id somewhere, so
 * the recorded history already holds the answer -- pair them by that value
 * and the gaps are a distribution.
 *
 * The number that matters most is not the median. It is how many of the
 * first messages never produced a second one: a step with a p95 of 40 ms
 * and eleven orders that never shipped is not a healthy step.
 */

export interface StepPair {
  value: string;
  from: number;
  to: number;
  deltaMs: number;
}

export interface StepLatency {
  pairs: StepPair[];
  /** messages of the first subject that never got a matching second one */
  unfinished: number;
  /** messages of the second subject with no first one before them */
  orphans: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** The value a message carries at a payload path or in a header, as a string. */
export function valueAt(message: NatsMessage, path: string): string | null {
  const key = path.trim();
  if (!key) return null;
  const header = message.headers?.[key] ?? message.headers?.[Object.keys(message.headers ?? {}).find(h => h.toLowerCase() === key.toLowerCase()) ?? ''];
  if (header?.[0] !== undefined) return String(header[0]);
  if (message.payloadType !== 'json') return null;
  let node: unknown = tryParseJson(message.payload);
  for (const step of key.split('.')) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[step];
  }
  if (node === null || node === undefined || typeof node === 'object') return null;
  return String(node);
}

const quantile = (sorted: number[], q: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);

/**
 * Pairs the messages of two subjects by a shared value and measures the gap.
 *
 * A second message belongs to the newest first message before it: a value
 * that repeats -- an order id used again a day later -- then pairs with the
 * run it belongs to rather than with the first one ever seen.
 */
export function stepLatency(from: NatsMessage[], to: NatsMessage[], field: string): StepLatency {
  const starts = new Map<string, number[]>();
  for (const m of from) {
    const v = valueAt(m, field);
    if (v === null) continue;
    const list = starts.get(v) ?? [];
    list.push(m.timestamp);
    starts.set(v, list);
  }
  for (const list of starts.values()) list.sort((a, b) => a - b);

  const used = new Map<string, Set<number>>();
  const pairs: StepPair[] = [];
  let orphans = 0;
  for (const m of [...to].sort((a, b) => a.timestamp - b.timestamp)) {
    const v = valueAt(m, field);
    const list = v === null ? undefined : starts.get(v);
    if (!v || !list) {
      orphans++;
      continue;
    }
    // The newest start at or before this message, not already spoken for.
    let best: number | null = null;
    for (const t of list) {
      if (t > m.timestamp) break;
      if (!used.get(v)?.has(t)) best = t;
    }
    if (best === null) {
      orphans++;
      continue;
    }
    const seen = used.get(v) ?? new Set<number>();
    seen.add(best);
    used.set(v, seen);
    pairs.push({ value: v, from: best, to: m.timestamp, deltaMs: m.timestamp - best });
  }

  let starters = 0;
  for (const list of starts.values()) starters += list.length;
  const sorted = pairs.map(p => p.deltaMs).sort((a, b) => a - b);
  return {
    pairs: pairs.sort((a, b) => b.deltaMs - a.deltaMs),
    unfinished: Math.max(0, starters - pairs.length),
    orphans,
    min: sorted[0] ?? 0,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** Log-spaced buckets, so a distribution from 1 ms to a minute has a shape. */
export function latencyBuckets(deltas: number[]): LatencyBucket[] {
  const bounds = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 30_000, 60_000];
  const buckets: LatencyBucket[] = [...bounds.map(le => ({ le, count: 0 })), { le: 0, count: 0 }];
  for (const d of deltas) {
    const i = bounds.findIndex(le => d <= le);
    buckets[i === -1 ? buckets.length - 1 : i].count++;
  }
  // Empty tails carry no information; the first and last non-empty bucket
  // are where the data is.
  const first = buckets.findIndex(b => b.count > 0);
  const last = buckets.length - 1 - [...buckets].reverse().findIndex(b => b.count > 0);
  return first === -1 ? [] : buckets.slice(first, last + 1);
}

/** The fields both sides carry, best first, as candidates for the pairing. */
export function sharedFields(from: NatsMessage[], to: NatsMessage[]): string[] {
  const KEYish = /(^|[._-])(id|uuid|guid|key|ref|correlation|order|session|request|txn|trace)([._-]|id)?$/i;
  const fieldsOf = (messages: NatsMessage[]) => {
    const names = new Set<string>();
    for (const m of messages.slice(0, 50)) {
      for (const k of Object.keys(m.headers ?? {})) names.add(k);
      if (m.payloadType !== 'json') continue;
      const doc = tryParseJson(m.payload);
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
        for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
          if (v !== null && typeof v !== 'object') names.add(k);
        }
      }
    }
    return names;
  };
  const a = fieldsOf(from);
  const b = fieldsOf(to);
  const shared = [...a].filter(k => b.has(k));
  return shared.sort((x, y) => Number(KEYish.test(y)) - Number(KEYish.test(x)));
}
