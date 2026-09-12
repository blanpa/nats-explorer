import { describe, expect, it } from 'vitest';
import type { NatsMessage } from 'shared';
import { PICK_WINDOW, messageForPoint, windowFor } from './pickMessage';

const msg = (t: number, temp: number): NatsMessage => ({
  subject: 'plant.temp',
  payload: JSON.stringify({ temp }),
  payloadType: 'json',
  timestamp: t,
  size: 20,
  sequence: t,
});

describe('messageForPoint', () => {
  const messages = [msg(1000, 20), msg(2000, 95), msg(3000, 21), msg(9000, 95)];

  it('picks the message whose value matches the point', () => {
    // The spike, not the message closest in time to the middle.
    expect(messageForPoint(messages, 'temp', { t: 2500, v: 95 }, 31_000)?.timestamp).toBe(2000);
    expect(messageForPoint(messages, 'temp', { t: 2500, v: 21 }, 31_000)?.timestamp).toBe(3000);
  });

  it('breaks a tie by time', () => {
    expect(messageForPoint(messages, 'temp', { t: 8500, v: 95 }, 31_000)?.timestamp).toBe(9000);
  });

  it('stays inside the window', () => {
    expect(messageForPoint(messages, 'temp', { t: 9000, v: 95 }, 500)?.timestamp).toBe(9000);
    expect(messageForPoint(messages, 'temp', { t: 50_000, v: 95 }, 5_000)).toBeNull();
  });

  it('ignores messages without the field', () => {
    const mixed = [{ ...msg(1000, 0), payload: '{"other":1}' }, msg(1200, 7)];
    expect(messageForPoint(mixed, 'temp', { t: 1000, v: 7 }, 5_000)?.timestamp).toBe(1200);
    expect(messageForPoint([{ ...msg(1000, 0), payload: 'plain text', payloadType: 'string' }], 'temp', { t: 1000, v: 1 }, 5_000)).toBeNull();
  });

  it('reads nested paths', () => {
    const nested = [{ ...msg(1000, 0), payload: JSON.stringify({ sensor: { temp: 42 } }) }];
    expect(messageForPoint(nested, 'sensor.temp', { t: 1000, v: 42 }, 5_000)?.timestamp).toBe(1000);
  });
});

describe('windowFor', () => {
  it('widens to a minute for aggregates', () => {
    expect(windowFor('rollup')).toBe(PICK_WINDOW.rollup);
    expect(windowFor(undefined)).toBe(PICK_WINDOW.series);
  });
});
