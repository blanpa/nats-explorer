import type { NatsMessage } from 'shared';
import { extractNumber } from '../../lib/utils';

/**
 * Finding the message behind a chart point. The point carries a time and a
 * value; the value is what makes it unambiguous, because a minute aggregate
 * or a downsampled series can cover many messages at nearly the same time.
 */

/** Half-widths of the search window: a minute for aggregates, seconds otherwise. */
export const PICK_WINDOW = { rollup: 31_000, series: 5_000 };

/**
 * Picks the message that produced a point: inside the window, the one whose
 * field value is closest, ties going to the closest in time. Returns null
 * when nothing in the window carries the field.
 */
export function messageForPoint(messages: NatsMessage[], fieldPath: string, point: { t: number; v: number }, window: number): NatsMessage | null {
  let best: NatsMessage | null = null;
  let bestValue = Infinity;
  let bestTime = Infinity;
  for (const m of messages) {
    const dt = Math.abs(m.timestamp - point.t);
    if (dt > window) continue;
    const v = extractNumber(m.payload, fieldPath);
    if (v === null) continue;
    const dv = Math.abs(v - point.v);
    if (dv < bestValue || (dv === bestValue && dt < bestTime)) {
      best = m;
      bestValue = dv;
      bestTime = dt;
    }
  }
  return best;
}

/** The window a point needs, depending on where the series came from. */
export function windowFor(source: string | undefined): number {
  return source === 'rollup' ? PICK_WINDOW.rollup : PICK_WINDOW.series;
}
