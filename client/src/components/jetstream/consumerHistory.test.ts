import { beforeEach, describe, expect, it } from 'vitest';
import type { ConsumerInfo } from 'shared';
import { type ConsumerSample, clearConsumerSamples, consumerSamples, consumerSeries, lagOf, pendingTrend, recordConsumer } from './consumerHistory';

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
