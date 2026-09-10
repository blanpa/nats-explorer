import type { NatsMessage } from 'shared';
import { tryParseJson } from './utils';

/**
 * The delay between a message being made and this explorer receiving it.
 *
 * Most payloads carry the producer's own clock -- `"timestamp":
 * "2026-09-10T18:05:54.703Z"`, or an epoch number -- and the explorer knows
 * when the message arrived. The difference is a figure nothing else in the
 * stack reports: it is the producer plus the network plus the server, and
 * when it climbs, one of those is in trouble.
 *
 * It is charted from the messages the browser holds, not from the server's
 * reduced series, because the server's series is one field's value and this
 * is two clocks subtracted.
 */

/** A field charted as a delay rather than as a value. */
export const DELAY_PREFIX = 'delay:';

export const isDelayField = (field: string): boolean => field.startsWith(DELAY_PREFIX);

/** The payload field a delay is measured from. */
export const delaySource = (field: string): string => field.slice(DELAY_PREFIX.length);

/** How a delay field reads in a legend. */
export const delayLabel = (field: string): string => `${delaySource(field)} → delay (ms)`;

/**
 * A value read as a point in time, or null.
 *
 * Three shapes are accepted: an ISO 8601 string, epoch milliseconds and
 * epoch seconds. Anything else -- a duration, a counter, a version number --
 * is not a time, and guessing would put a nonsense curve on the screen.
 */
export function parseTimeValue(v: unknown): number | null {
  if (typeof v === 'string') {
    // Only the ISO shape: Date.parse takes far more than that, including
    // strings that are plainly not times.
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Milliseconds since the epoch, from 2001 to 2286.
    if (v > 1e12 && v < 1e13) return v;
    // Seconds, over the same span.
    if (v > 1e9 && v < 1e10) return v * 1000;
  }
  return null;
}

/** A year either side of the message: further off and it is not its own clock. */
const PLAUSIBLE_MS = 365 * 24 * 3600 * 1000;

/**
 * The top-level fields of a message that look like the moment it was made.
 *
 * A value is only taken for one when it lands near the message's own arrival
 * time. An epoch number from another decade is a stored date, not a
 * timestamp, and charting the delay from it would say the producer is a year
 * behind.
 */
export function timeFieldsOf(message: NatsMessage): string[] {
  if (message.payloadType !== 'json') return [];
  const doc = tryParseJson(message.payload);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    const t = parseTimeValue(v);
    if (t !== null && Math.abs(message.timestamp - t) < PLAUSIBLE_MS) out.push(k);
  }
  return out;
}

/**
 * How long the message took to arrive, by its own clock. Negative when the
 * producer's clock runs ahead of this machine's, which is worth seeing
 * rather than hiding: a delay that reads -400 ms is a clock problem, and
 * clamping it at zero would present it as a healthy one.
 */
export function delayOf(message: NatsMessage, field: string): number | null {
  if (message.payloadType !== 'json') return null;
  const doc = tryParseJson(message.payload);
  if (!doc || typeof doc !== 'object') return null;
  const t = parseTimeValue((doc as Record<string, unknown>)[field]);
  return t === null ? null : message.timestamp - t;
}
