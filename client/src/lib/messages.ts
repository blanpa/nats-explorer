import type { NatsMessage } from 'shared';

/** Identity of a message across feed and history: connection, subject and arrival number. */
export const messageKey = (m: NatsMessage) => `${m.connId ?? ''}:${m.subject}:${m.sequence ?? m.timestamp}`;

/** Oldest first, by time and then arrival number. */
export const byArrival = (a: NatsMessage, b: NatsMessage) => a.timestamp - b.timestamp || (a.sequence ?? 0) - (b.sequence ?? 0);

/** Newest first. */
export const newerFirst = (a: NatsMessage, b: NatsMessage) => byArrival(b, a);

/** Messages per second over the last ten seconds of a list sorted oldest first. */
export function recentRate(messages: NatsMessage[], now = Date.now()): number {
  const cutoff = now - 10_000;
  let n = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i].timestamp >= cutoff; i--) n++;
  return n / 10;
}
