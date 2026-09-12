import { beforeEach, describe, expect, it } from 'vitest';
import type { ConsumerInfo } from 'shared';
import {
  type ConsumerSample,
  clearConsumerSamples,
  consumerSamples,
  consumerSeries,
  describeBacklog,
  drainForecast,
  lagOf,
  pendingTrend,
  recordConsumer,
} from './consumerHistory';

const info = (over: Partial<ConsumerInfo> = {}): ConsumerInfo =>
  ({
    name: 'worker',
    streamName: 'ORDERS',
    created: '',
    config: {},
    delivered: { consumerSeq: 5, streamSeq: 90 },
    ackFloor: { consumerSeq: 5, streamSeq: 90 },
    numAckPending: 2,
    numRedelivered: 0,
    numWaiting: 1,
    numPending: 10,
    push: false,
    ...over,
  }) as ConsumerInfo;

const sample = (pending: number, t = 0): ConsumerSample => ({ t, pending, ackPending: 0, redelivered: 0, deliveredStreamSeq: 0, waiting: 0 });

beforeEach(() => clearConsumerSamples('c1', 'ORDERS'));

describe('consumer history', () => {
  it('records a sample per poll and keeps them per consumer', () => {
    recordConsumer('c1', 'ORDERS', info(), 1000);
    recordConsumer('c1', 'ORDERS', info({ numPending: 12 }), 6000);
    recordConsumer('c1', 'ORDERS', info({ name: 'other' }), 6000);
    const samples = consumerSamples('c1', 'ORDERS', 'worker');
    expect(samples.map(s => s.pending)).toEqual([10, 12]);
    expect(consumerSamples('c1', 'ORDERS', 'other')).toHaveLength(1);
    expect(consumerSamples('c1', 'OTHER', 'worker')).toEqual([]);
  });

  it('ignores a refresh right after a poll', () => {
    recordConsumer('c1', 'ORDERS', info(), 1000);
    recordConsumer('c1', 'ORDERS', info({ numPending: 99 }), 1200);
    expect(consumerSamples('c1', 'ORDERS', 'worker')).toHaveLength(1);
  });

  it('drops the samples of a stream together', () => {
    recordConsumer('c1', 'ORDERS', info(), 1000);
    clearConsumerSamples('c1', 'ORDERS');
    expect(consumerSamples('c1', 'ORDERS', 'worker')).toEqual([]);
  });

  it('builds a series of times and values', () => {
    const s = [sample(1, 10), sample(3, 20)];
    expect(consumerSeries(s, x => x.pending)).toEqual({ times: [10, 20], values: [1, 3] });
  });
});

describe('lagOf', () => {
  it('is the distance to the stream head, never negative', () => {
    expect(lagOf(info(), 100)).toBe(10);
    expect(lagOf(info(), 90)).toBe(0);
    expect(lagOf(info(), 50)).toBe(0);
    expect(lagOf(info(), undefined)).toBeNull();
  });
});

describe('pendingTrend', () => {
  it('reports a growing backlog, not a single spike', () => {
    expect(pendingTrend([sample(1), sample(2), sample(3), sample(8), sample(12)])).toBe('up');
    expect(pendingTrend([sample(12), sample(8), sample(3), sample(2), sample(1)])).toBe('down');
    expect(pendingTrend([sample(5), sample(5), sample(5), sample(5), sample(5)])).toBe('flat');
    expect(pendingTrend([sample(0), sample(1), sample(0)])).toBe('flat');
    expect(pendingTrend([sample(1), sample(2)])).toBe('flat');
  });
});

describe('drainForecast', () => {
  /** Samples every five seconds, pending changing by `step` each time. */
  const run = (from: number, step: number, count = 10): ConsumerSample[] =>
    Array.from({ length: count }, (_, i) => ({
      t: 1_000_000 + i * 5000,
      pending: Math.max(0, from + step * i),
      ackPending: 0,
      redelivered: 0,
      deliveredStreamSeq: i,
      waiting: 0,
    }));

  it('says when a backlog will be empty', () => {
    // 2 000 behind, 200 fewer every five seconds: 40/s. The last sample is
    // 200, so five seconds to go.
    const f = drainForecast(run(2000, -200))!;
    expect(f.direction).toBe('down');
    expect(f.perSecond).toBeCloseTo(-40, 5);
    expect(f.etaMs).toBeCloseTo(5000, -1);
  });

  it('gives no time to a consumer that is falling behind', () => {
    const f = drainForecast(run(100, 60))!;
    expect(f.direction).toBe('up');
    expect(f.etaMs).toBeNull();
  });

  it('calls a queue that barely moves flat', () => {
    const f = drainForecast(run(500, 0))!;
    expect(f.direction).toBe('flat');
    expect(f.etaMs).toBeNull();
  });

  it('says nothing from one poll, or from polls a moment apart', () => {
    expect(drainForecast(run(500, -10, 2))).toBeNull();
    const tooFast = run(500, -10, 6).map((s, i) => ({ ...s, t: 1_000_000 + i * 100 }));
    expect(drainForecast(tooFast)).toBeNull();
  });
});

describe('describeBacklog', () => {
  const samples = (step: number) =>
    Array.from({ length: 10 }, (_, i) => ({
      t: 1_000_000 + i * 5000,
      pending: 2000 + step * i,
      ackPending: 0,
      redelivered: 0,
      deliveredStreamSeq: i,
      waiting: 0,
    }));

  it('turns the numbers into the sentence someone can act on', () => {
    expect(describeBacklog(200, drainForecast(samples(-200)))).toContain('catching up at 40/s');
    expect(describeBacklog(200, drainForecast(samples(-200)))).toContain('empty in about');
    expect(describeBacklog(2540, drainForecast(samples(60)))).toContain('not catching up');
    expect(describeBacklog(2000, drainForecast(samples(0)))).toContain('holding steady');
    expect(describeBacklog(2000, null)).toContain('watching for a minute');
  });
});
