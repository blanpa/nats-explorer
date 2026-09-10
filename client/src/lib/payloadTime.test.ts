import type { NatsMessage } from 'shared';
import { describe, expect, it } from 'vitest';
import { delayOf, DELAY_PREFIX, delayLabel, delaySource, isDelayField, parseTimeValue, timeFieldsOf } from './payloadTime';

const at = new Date('2026-09-10T18:05:55.000Z').getTime();
const msg = (payload: unknown, timestamp = at): NatsMessage => ({
  subject: 'plant.robot',
  payload: JSON.stringify(payload),
  payloadType: 'json',
  timestamp,
  size: 10,
});

describe('parseTimeValue', () => {
  it('takes the three shapes a producer writes', () => {
    expect(parseTimeValue('2026-09-10T18:05:54.703Z')).toBe(Date.parse('2026-09-10T18:05:54.703Z'));
    expect(parseTimeValue('2026-09-10 18:05:54')).toBe(Date.parse('2026-09-10 18:05:54'));
    expect(parseTimeValue(1_789_063_554_703)).toBe(1_789_063_554_703);
    expect(parseTimeValue(1_789_063_554)).toBe(1_789_063_554_000);
  });

  it('refuses what is not a time', () => {
    // A duration, a counter, a version, a plain word: guessing would put a
    // nonsense curve on the screen.
    expect(parseTimeValue(42)).toBeNull();
    expect(parseTimeValue('v2.1.0')).toBeNull();
    expect(parseTimeValue('yesterday')).toBeNull();
    expect(parseTimeValue(null)).toBeNull();
    expect(parseTimeValue({})).toBeNull();
    expect(parseTimeValue('2026-13-45T99:99')).toBeNull();
  });
});

describe('timeFieldsOf', () => {
  it('finds the field that carries the moment the message was made', () => {
    expect(timeFieldsOf(msg({ x: 1, timestamp: '2026-09-10T18:05:54.703Z' }))).toEqual(['timestamp']);
  });

  it('leaves a date from another decade alone', () => {
    // A stored date is not the producer's clock, and a delay from it would
    // say the producer is a year behind.
    expect(timeFieldsOf(msg({ born: '1998-04-01T00:00:00Z' }))).toEqual([]);
  });

  it('has nothing to say about a payload that is not JSON', () => {
    expect(timeFieldsOf({ ...msg({}), payloadType: 'binary' })).toEqual([]);
    expect(timeFieldsOf(msg([1, 2, 3]))).toEqual([]);
  });
});

describe('delayOf', () => {
  it('is the time between the producer’s clock and the arrival', () => {
    expect(delayOf(msg({ timestamp: '2026-09-10T18:05:54.703Z' }), 'timestamp')).toBe(297);
  });

  it('reports a producer whose clock runs ahead, rather than hiding it', () => {
    // -400 ms is a clock problem; clamping it at zero would present it as a
    // healthy one.
    expect(delayOf(msg({ t: '2026-09-10T18:05:55.400Z' }), 't')).toBe(-400);
    expect(delayOf(msg({ t: at + 400 }, at), 't')).toBe(-400);
  });

  it('is nothing where the field is not a time', () => {
    expect(delayOf(msg({ t: 'soon' }), 't')).toBeNull();
    expect(delayOf(msg({ other: 1 }), 't')).toBeNull();
  });
});

describe('delay fields', () => {
  it('name themselves apart from a value', () => {
    const f = `${DELAY_PREFIX}timestamp`;
    expect(isDelayField(f)).toBe(true);
    expect(isDelayField('timestamp')).toBe(false);
    expect(delaySource(f)).toBe('timestamp');
    expect(delayLabel(f)).toBe('timestamp → delay (ms)');
  });
});
