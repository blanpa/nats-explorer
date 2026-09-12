import type { NatsMessage } from 'shared';
import { describe, expect, it } from 'vitest';
import { byArrival, messageKey, newerFirst, recentRate } from './messages';

const msg = (over: Partial<NatsMessage>): NatsMessage => ({
  subject: 'plant.temp',
  payload: '{}',
  payloadType: 'json',
  timestamp: 1000,
  size: 2,
  sequence: 1,
  connId: 'c',
  ...over,
});

describe('messageKey', () => {
  it('tells apart two messages numbered the same in different runs', () => {
    // Sequences count per connection and start at one again on reconnect, so
    // a history reaching back over a restart holds many messages numbered 2.
    const runA = msg({ sequence: 2, timestamp: 1_000 });
    const runB = msg({ sequence: 2, timestamp: 90_000 });
    expect(messageKey(runA)).not.toBe(messageKey(runB));
  });

  it('gives one message one key, wherever it came from', () => {
    // The same message from the live feed and from the database has to
    // dedupe, or paging back would show it twice.
    expect(messageKey(msg({}))).toBe(messageKey(msg({})));
  });

  it('keeps messages of different subjects and connections apart', () => {
    expect(messageKey(msg({ subject: 'plant.other' }))).not.toBe(messageKey(msg({})));
    expect(messageKey(msg({ connId: 'd' }))).not.toBe(messageKey(msg({})));
  });

  it('still names a message that never got a sequence', () => {
    expect(messageKey(msg({ sequence: undefined }))).toContain('1000');
  });
});

describe('byArrival', () => {
  it('orders by time first, so a restart does not shuffle the list', () => {
    const older = msg({ sequence: 9000, timestamp: 1000 });
    const newer = msg({ sequence: 1, timestamp: 2000 });
    expect([newer, older].sort(byArrival)).toEqual([older, newer]);
    expect([older, newer].sort(newerFirst)).toEqual([newer, older]);
  });

  it('falls back to the sequence inside one millisecond', () => {
    const a = msg({ sequence: 1, timestamp: 1000 });
    const b = msg({ sequence: 2, timestamp: 1000 });
    expect([b, a].sort(byArrival)).toEqual([a, b]);
  });
});

describe('recentRate', () => {
  it('counts the last ten seconds of an oldest-first list', () => {
    const now = 100_000;
    const messages = [msg({ timestamp: now - 30_000 }), msg({ timestamp: now - 5_000 }), msg({ timestamp: now - 1_000 })];
    expect(recentRate(messages, now)).toBe(0.2);
  });
});
