import { describe, expect, it } from 'vitest';
import type { HistorySeries, NatsMessage } from 'shared';
import { decimate, mergePoints } from './ValueChart';

const pts = (values: number[]) => values.map((v, i) => ({ t: i, v }));

describe('decimate', () => {
  it('keeps every point when there is room', () => {
    expect(decimate(pts([1, 2, 3]), 10)).toHaveLength(3);
  });
  it('keeps min and max per bucket in time order', () => {
    const out = decimate(pts([0, 9, 1, 2, 8, 3, 4, 5, 7, 6]), 2);
    expect(out.map(p => p.v)).toEqual([0, 9, 3, 7]);
    expect(out.map(p => p.t)).toEqual([0, 1, 5, 8]);
  });
});

describe('mergePoints', () => {
  const msg = (seq: number, v: number): NatsMessage => ({
    subject: 's',
    payload: JSON.stringify({ a: { b: v } }),
    payloadType: 'json',
    timestamp: 1000 + seq,
    size: 1,
    sequence: seq,
  });
  it('appends only the live messages the series does not already cover', () => {
    // Where the answer ends is a time, not a sequence number: the numbers
    // start over with every reconnect, the clock does not.
    const series: HistorySeries = {
      subject: 's',
      field: 'a.b',
      points: [
        [1001, 10],
        [1005, 50],
      ],
      samples: 2,
      last: 5,
    };
    const out = mergePoints(series, [msg(4, 40), msg(5, 50), msg(6, 60)], 'a.b');
    expect(out.map(p => p.v)).toEqual([10, 50, 60]);
  });
  it('falls back to the live messages without a series', () => {
    expect(mergePoints(null, [msg(1, 1), msg(2, 2)], 'a.b').map(p => p.v)).toEqual([1, 2]);
  });
});
