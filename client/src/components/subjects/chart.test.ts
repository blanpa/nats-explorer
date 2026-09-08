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
  it('appends only live messages newer than the series', () => {
    const series: HistorySeries = {
      subject: 's',
      field: 'a.b',
      points: [
        [1, 10],
        [2, 20],
      ],
      samples: 2,
      last: 5,
    };
    const out = mergePoints(series, [msg(4, 40), msg(5, 50), msg(6, 60)], 'a.b');
    expect(out.map(p => p.v)).toEqual([10, 20, 60]);
  });
  it('falls back to the live messages without a series', () => {
    expect(mergePoints(null, [msg(1, 1), msg(2, 2)], 'a.b').map(p => p.v)).toEqual([1, 2]);
  });
});
