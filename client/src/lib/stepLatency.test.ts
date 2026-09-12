import { describe, expect, it } from 'vitest';
import type { NatsMessage } from 'shared';
import { latencyBuckets, sharedFields, stepLatency, valueAt } from './stepLatency';

const msg = (subject: string, t: number, payload: unknown, headers?: Record<string, string[]>): NatsMessage => ({
  subject,
  payload: JSON.stringify(payload),
  payloadType: 'json',
  timestamp: t,
  size: 1,
  headers,
});

describe('valueAt', () => {
  it('reads a payload field, a nested one, and a header', () => {
    const m = msg('s', 1, { id: 'ORD-1', meta: { ref: 7 } }, { 'Nats-Msg-Id': ['abc'] });
    expect(valueAt(m, 'id')).toBe('ORD-1');
    expect(valueAt(m, 'meta.ref')).toBe('7');
    expect(valueAt(m, 'nats-msg-id')).toBe('abc');
    expect(valueAt(m, 'missing')).toBeNull();
    // An object is not an id, and neither is an empty path.
    expect(valueAt(m, 'meta')).toBeNull();
    expect(valueAt(m, '  ')).toBeNull();
  });
});

describe('stepLatency', () => {
  it('measures the gap between two subjects, per id', () => {
    const created = [msg('a', 1000, { id: 'x' }), msg('a', 2000, { id: 'y' }), msg('a', 3000, { id: 'z' })];
    const paid = [msg('b', 1200, { id: 'x' }), msg('b', 2500, { id: 'y' })];
    const s = stepLatency(created, paid, 'id');
    expect(s.pairs.map(p => p.deltaMs).sort((a, b) => a - b)).toEqual([200, 500]);
    expect(s.p50).toBe(500);
    expect(s.min).toBe(200);
    // z never arrived: the number that matters most.
    expect(s.unfinished).toBe(1);
    expect(s.orphans).toBe(0);
  });

  it('counts a second message with nothing before it', () => {
    const s = stepLatency([msg('a', 1000, { id: 'x' })], [msg('b', 900, { id: 'x' }), msg('b', 1100, { id: 'nope' })], 'id');
    // One arrived before its start, one has no start at all.
    expect(s.pairs).toHaveLength(0);
    expect(s.orphans).toBe(2);
    expect(s.unfinished).toBe(1);
  });

  it('pairs a repeated id with the run it belongs to', () => {
    const created = [msg('a', 1000, { id: 'x' }), msg('a', 10_000, { id: 'x' })];
    const paid = [msg('b', 1500, { id: 'x' }), msg('b', 10_200, { id: 'x' })];
    const s = stepLatency(created, paid, 'id');
    expect(s.pairs.map(p => p.deltaMs).sort((a, b) => a - b)).toEqual([200, 500]);
    expect(s.unfinished).toBe(0);
  });

  it('has nothing to say about messages that do not carry the field', () => {
    const s = stepLatency([msg('a', 1, { other: 1 })], [msg('b', 2, { other: 1 })], 'id');
    expect(s.pairs).toHaveLength(0);
    expect(s.unfinished).toBe(0);
    expect(s.orphans).toBe(1);
  });
});

describe('latencyBuckets', () => {
  it('spaces the bars by magnitude and trims the empty ends', () => {
    const buckets = latencyBuckets([2, 3, 4, 40, 900]);
    expect(buckets[0].le).toBe(5);
    expect(buckets[buckets.length - 1].le).toBe(1000);
    expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(5);
  });
  it('puts what is slower than the last bound in the overflow', () => {
    const buckets = latencyBuckets([120_000]);
    expect(buckets).toEqual([{ le: 0, count: 1 }]);
  });
});

describe('sharedFields', () => {
  it('offers what both sides carry, id-like names first', () => {
    const from = [msg('a', 1, { order_id: 'x', total: 5, only_here: 1 })];
    const to = [msg('b', 2, { order_id: 'x', total: 5 })];
    expect(sharedFields(from, to)).toEqual(['order_id', 'total']);
  });
});
