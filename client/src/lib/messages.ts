import type { NatsMessage } from 'shared';

/** Identity of a message across feed and history: connection, subject and arrival number. */
/**
 * What makes a message that one, for dedupe and for React keys.
 *
 * The time is part of it and not a fallback. Sequence numbers count per
 * connection and start at one again with every reconnect, so a history that
 * spans two runs -- which reading past the edge of memory into the database
 * does -- holds many messages numbered 2. Keyed by sequence alone they
 * looked like the same message and every one but the first was thrown away:
 * on a demo database, 14 819 messages came back as 8 092.
 */
export const messageKey = (m: NatsMessage) => `${m.connId ?? ''}:${m.subject}:${m.timestamp}:${m.sequence ?? ''}`;

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
