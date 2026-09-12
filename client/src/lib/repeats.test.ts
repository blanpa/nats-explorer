import { describe, expect, it } from 'vitest';
import type { NatsMessage } from 'shared';
import { describeRepeat, findRepeats } from './repeats';

const msg = (subject: string, t: number, payload: string): NatsMessage => ({ subject, payload, payloadType: 'json', timestamp: t, size: payload.length });

describe('findRepeats', () => {
  it('marks the identical payload among changing ones', () => {
    const messages = [
      msg('orders.created', 1000, '{"id":1}'),
      msg('orders.created', 2000, '{"id":2}'),
      msg('orders.created', 2500, '{"id":2}'), // the retry
      msg('orders.created', 3000, '{"id":3}'),
    ];
    const repeats = findRepeats(messages);
    expect(repeats.size).toBe(1);
    const hit = repeats.get(messages[2])!;
    expect(hit.count).toBe(2);
    expect(hit.sinceMs).toBe(500);
    expect(describeRepeat(hit)).toContain('2 times');
  });

  it('counts a storm as one growing run', () => {
    const messages = [msg('a', 0, 'x'), msg('a', 100, 'p'), msg('a', 200, 'x'), msg('a', 300, 'x'), msg('a', 400, 'q')];
    const repeats = findRepeats(messages);
    expect([...repeats.values()].map(r => r.count)).toEqual([2, 3]);
  });

  it('leaves a subject alone whose payload never changes', () => {
    // A status that says "running" every second is a level, not a retry.
    const messages = Array.from({ length: 8 }, (_, i) => msg('plant.status', i * 1000, '{"state":"running"}'));
    expect(findRepeats(messages).size).toBe(0);
  });

  it('forgets a payload once the window has passed', () => {
    const messages = [msg('a', 0, 'x'), msg('a', 1000, 'y'), msg('a', 60_000, 'x')];
    expect(findRepeats(messages).size).toBe(0);
  });

  it('keeps subjects apart', () => {
    expect(findRepeats([msg('a', 0, 'x'), msg('b', 100, 'x')]).size).toBe(0);
  });
});
