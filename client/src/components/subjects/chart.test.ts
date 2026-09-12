import { describe, expect, it } from 'vitest';
import type { HistorySeries, NatsMessage } from 'shared';
import { decimate, extendSeries, gapAfter, mergePoints, niceTicks, splitOnGaps } from './ValueChart';

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

describe('splitOnGaps', () => {
  /** Points every `every` ms, with the silences after the given indexes. */
  const run = (count: number, every: number, holes: Record<number, number> = {}) => {
    const out: { t: number; v: number }[] = [];
    let t = 0;
    for (let i = 0; i < count; i++) {
      out.push({ t, v: i });
      t += (holes[i] ?? 0) + every;
    }
    return out;
  };

  it('keeps an evenly sent series in one piece', () => {
    expect(splitOnGaps(run(20, 1000))).toHaveLength(1);
  });
  it('tolerates a missed message or two', () => {
    // One gap of three intervals is jitter, not a silence.
    expect(splitOnGaps(run(20, 1000, { 9: 2000 }))).toHaveLength(1);
  });
  it('cuts the line where the subject went quiet', () => {
    const parts = splitOnGaps(run(20, 1000, { 9: 60_000 }));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(10);
    expect(parts[1]).toHaveLength(10);
  });
  it('says nothing about too few points, and never loses one', () => {
    expect(gapAfter(run(4, 1000))).toBe(Number.POSITIVE_INFINITY);
    expect(splitOnGaps(run(4, 1000))).toHaveLength(1);
    const many = run(30, 1000, { 5: 90_000, 20: 90_000 });
    expect(splitOnGaps(many).flat()).toEqual(many);
  });
  it('is not fooled by the pairs decimation leaves behind', () => {
    // Two points per bucket: a tiny distance inside, the bucket between.
    const pairs: { t: number; v: number }[] = [];
    for (let b = 0; b < 15; b++) pairs.push({ t: b * 1000, v: 1 }, { t: b * 1000 + 20, v: 2 });
    expect(splitOnGaps(pairs)).toHaveLength(1);
  });
});

describe('niceTicks', () => {
  it('labels a narrow range with round steps, not with the extremes', () => {
    // A sensor between 22.3 and 22.4 used to be labelled 22.37 and 22.33.
    expect(niceTicks(22.3, 22.4)).toEqual([22.3, 22.35, 22.4]);
  });
  it('steps in 1, 2, 2.5 or 5 of the right magnitude', () => {
    expect(niceTicks(0, 1000)).toEqual([0, 500, 1000]);
    expect(niceTicks(0, 30)).toEqual([0, 10, 20, 30]);
    expect(niceTicks(-6, 6)).toEqual([-5, 0, 5]);
  });
  it('draws enough lines to read the scale by', () => {
    // A range of five used to end up with two lines: the widest round step
    // that fits is not the one that says the most.
    expect(niceTicks(18.65, 23.76)).toEqual([19, 20, 21, 22, 23]);
    for (const [lo, hi] of [
      [0, 1],
      [0.001, 0.004],
      [-40, 120],
      [999_000, 1_001_000],
    ]) {
      expect(niceTicks(lo, hi).length).toBeGreaterThanOrEqual(3);
      expect(niceTicks(lo, hi).length).toBeLessThanOrEqual(7);
    }
  });
  it('adds no digits the step does not have', () => {
    for (const v of niceTicks(0, 0.3)) expect(String(v).length).toBeLessThanOrEqual(4);
  });
  it('survives a range of nothing', () => {
    expect(niceTicks(5, 5)).toEqual([5]);
    expect(niceTicks(Number.NaN, 1)).toEqual([Number.NaN]);
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

  // A reduced series used to stand still between two answers of the server,
  // for up to fifteen seconds; now it continues in its own buckets.
  const reduced = (points: [number, number][], samples: number, over: Partial<HistorySeries> = {}): HistorySeries => ({
    subject: 's',
    field: 'a.b',
    points,
    samples,
    last: 0,
    ...over,
  });

  it('continues an average in the buckets the server used', () => {
    // Six samples behind three points: two messages make one more point.
    const series = reduced(
      [
        [1002, 1],
        [1004, 2],
        [1006, 3],
      ],
      6,
    );
    const out = mergePoints(series, [msg(7, 10), msg(8, 20), msg(9, 30), msg(10, 50), msg(11, 99)], 'a.b', 'avg');
    // (10+20)/2 and (30+50)/2; the lone 99 waits for its pair.
    expect(out.map(p => p.v)).toEqual([1, 2, 3, 15, 40]);
    expect(out[out.length - 1].t).toBe(1010);
  });

  it('reduces the live bucket the way the reader asked for', () => {
    const series = reduced([[1002, 1]], 2);
    const live = [msg(3, 5), msg(4, 15)];
    expect(mergePoints(series, live, 'a.b', 'min').map(p => p.v)).toEqual([1, 5]);
    expect(mergePoints(series, live, 'a.b', 'max').map(p => p.v)).toEqual([1, 15]);
    expect(mergePoints(series, live, 'a.b', 'sum').map(p => p.v)).toEqual([1, 20]);
    expect(mergePoints(series, live, 'a.b', 'count').map(p => p.v)).toEqual([1, 2]);
  });

  it('keeps a counter rate positive and pairwise', () => {
    const series = reduced([[1000, 0]], 1);
    // One message per bucket: 100 more in 2 s, then a restart to 5.
    const out = extendSeries(
      series,
      [
        { t: 2000, v: 100 },
        { t: 4000, v: 300 },
        { t: 6000, v: 5 },
      ],
      'rate',
    );
    expect(out).toEqual([
      { t: 4000, v: 100 },
      { t: 6000, v: 0 },
    ]);
  });

  it('leaves the minute rollup to the server', () => {
    const series = reduced([[60_000, 1]], 120, { source: 'rollup' });
    expect(mergePoints(series, [msg(1, 9), msg(2, 9)], 'a.b', 'avg').map(p => p.v)).toEqual([1]);
  });
});
