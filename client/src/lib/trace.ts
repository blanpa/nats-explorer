import type { NatsMessage } from 'shared';
import { msgId } from './natsHeaders';
import { tryParseJson } from './utils';

/**
 * Following one thing through several subjects.
 *
 * A request and its reply, an order and its shipment, a saga across five
 * services: the messages belong together but live on different subjects, and
 * what ties them is a value inside them -- an order id, a correlation id, a
 * deduplication header. The recorded history can be searched for that value
 * across every subject, which turns "where did it go?" into a list.
 *
 * What it cannot do is guess the value, so it offers the candidates and lets
 * the reader pick.
 */

export interface TraceCandidate {
  /** where it was found: a payload path, or a header name */
  label: string;
  value: string;
}

/** Field names that usually tie messages together. */
const KEYish = /(^|[._-])(id|uuid|guid|key|ref|reference|correlation|correlationid|traceid|trace|span|order|session|request|txn|transaction)([._-]|id)?$/i;

/** A value worth searching for: short enough to be an id, long enough to be one. */
function usable(v: unknown): v is string | number {
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) >= 1000;
  return typeof v === 'string' && v.length >= 4 && v.length <= 128 && !/^\s*$/.test(v);
}

/**
 * The values of a message that could tie it to others, best first: the
 * deduplication header, then the fields whose name reads like an id, then
 * anything else short enough to be one.
 */
export function traceCandidates(message: NatsMessage): TraceCandidate[] {
  const out: TraceCandidate[] = [];
  const id = msgId(message.headers);
  if (id) out.push({ label: 'Nats-Msg-Id', value: id });
  for (const [k, vals] of Object.entries(message.headers ?? {})) {
    if (k.toLowerCase() === 'nats-msg-id') continue;
    if (KEYish.test(k) && usable(vals[0])) out.push({ label: k, value: String(vals[0]) });
  }
  if (message.payloadType === 'json') {
    const doc = tryParseJson(message.payload);
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
      const entries = Object.entries(doc as Record<string, unknown>).filter(([, v]) => usable(v));
      for (const [k, v] of entries) if (KEYish.test(k)) out.push({ label: k, value: String(v) });
      // Then the rest, so a payload whose id field is called something else
      // still offers it -- lower down, because a guess is what it is.
      for (const [k, v] of entries) if (!KEYish.test(k) && typeof v === 'string') out.push({ label: k, value: String(v) });
    }
  }
  const seen = new Set<string>();
  return out.filter(c => (seen.has(c.value) ? false : (seen.add(c.value), true))).slice(0, 8);
}

/** One step of a trace: a message and how long after the one before it. */
export interface TraceStep {
  message: NatsMessage;
  /** milliseconds since the previous step, or null for the first */
  gap: number | null;
}

/** The hits in time order, each with the gap to the one before. */
export function traceSteps(messages: NatsMessage[]): TraceStep[] {
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  return sorted.map((message, i) => ({ message, gap: i === 0 ? null : message.timestamp - sorted[i - 1].timestamp }));
}
