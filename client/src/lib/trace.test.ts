import type { NatsMessage } from 'shared';
import { describe, expect, it } from 'vitest';
import { traceCandidates, traceSteps } from './trace';

const msg = (over: Partial<NatsMessage> = {}): NatsMessage => ({
  subject: 'orders.created',
  payload: JSON.stringify({ id: 'ORD-1089', total: 571.54, currency: 'EUR' }),
  payloadType: 'json',
  timestamp: 1_000,
  size: 40,
  ...over,
});

describe('traceCandidates', () => {
  it('offers the deduplication header first', () => {
    // It is the one value NATS itself treats as the identity of a message.
    const c = traceCandidates(msg({ headers: { 'Nats-Msg-Id': ['abc-123'] } }));
    expect(c[0]).toEqual({ label: 'Nats-Msg-Id', value: 'abc-123' });
  });

  it('then the fields whose name reads like an id', () => {
    const c = traceCandidates(msg({ payload: JSON.stringify({ total: 5000, order_id: 'ORD-1', note: 'hello there' }) }));
    expect(c[0].label).toBe('order_id');
  });

  it('offers other strings after them, because a guess is what it is', () => {
    const c = traceCandidates(msg({ payload: JSON.stringify({ id: 'ORD-1089', region: 'europe-west', currency: 'EUR' }) }));
    // `currency` is three characters: too short to tie two messages together.
    expect(c.map(x => x.label)).toEqual(['id', 'region']);
  });

  it('leaves out what cannot be an id', () => {
    // Too short, blank, or a small number that is a quantity.
    const c = traceCandidates(msg({ payload: JSON.stringify({ a: 'ab', b: '   ', items: 3 }) }));
    expect(c).toEqual([]);
  });

  it('says nothing about a payload it cannot read', () => {
    expect(traceCandidates(msg({ payloadType: 'binary', payload: 'AAEC' }))).toEqual([]);
  });

  it('offers a value once, however many fields carry it', () => {
    const c = traceCandidates(msg({ headers: { 'Nats-Msg-Id': ['ORD-1089'] } }));
    expect(c.filter(x => x.value === 'ORD-1089')).toHaveLength(1);
  });
});

describe('traceSteps', () => {
  it('puts the hits in time order with the gap to the one before', () => {
    const steps = traceSteps([
      msg({ timestamp: 3_000, subject: 'orders.shipped' }),
      msg({ timestamp: 1_000 }),
      msg({ timestamp: 1_400, subject: 'orders.paid' }),
    ]);
    expect(steps.map(s => s.message.subject)).toEqual(['orders.created', 'orders.paid', 'orders.shipped']);
    expect(steps.map(s => s.gap)).toEqual([null, 400, 1600]);
  });

  it('leaves the caller’s list alone', () => {
    const list = [msg({ timestamp: 2 }), msg({ timestamp: 1 })];
    traceSteps(list);
    expect(list.map(m => m.timestamp)).toEqual([2, 1]);
  });
});
