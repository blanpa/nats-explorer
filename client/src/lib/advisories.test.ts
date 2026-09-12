import { describe, expect, it } from 'vitest';
import type { NatsMessage } from 'shared';
import { countBySeverity, describeEvent, eventsOf } from './advisories';

const msg = (subject: string, payload: unknown, t = 1000): NatsMessage => ({
  subject,
  payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  payloadType: typeof payload === 'string' ? 'string' : 'json',
  timestamp: t,
  size: 1,
});

const ADVISORY = '$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.ORDERS.billing';

describe('describeEvent', () => {
  it('says what a consumer gave up on', () => {
    const e = describeEvent(
      msg(ADVISORY, {
        type: 'io.nats.jetstream.advisory.v1.max_deliver',
        stream: 'ORDERS',
        consumer: 'billing',
        stream_seq: 41,
        deliveries: 5,
      }),
    );
    expect(e?.severity).toBe('error');
    expect(e?.title).toBe('billing on ORDERS gave up on sequence 41 after 5 deliveries');
    expect(e?.stream).toBe('ORDERS');
    expect(e?.consumer).toBe('billing');
  });

  it('reads a nak with its backoff', () => {
    const e = describeEvent(
      msg('$JS.EVENT.ADVISORY.CONSUMER.MSG_NAKED.ORDERS.billing', {
        type: 'io.nats.jetstream.advisory.v1.nak',
        stream: 'ORDERS',
        consumer: 'billing',
        stream_seq: 7,
        delay: 30_000_000_000,
      }),
    );
    expect(e?.severity).toBe('warn');
    expect(e?.title).toContain('again in 30s');
  });

  it('tells a failed API call from a healthy one', () => {
    const ok = describeEvent(
      msg('$JS.EVENT.ADVISORY.API', { type: 'io.nats.jetstream.advisory.v1.api_audit', subject: '$JS.API.STREAM.INFO.ORDERS', response: '{"total":1}' }),
    );
    const bad = describeEvent(
      msg('$JS.EVENT.ADVISORY.API', {
        type: 'io.nats.jetstream.advisory.v1.api_audit',
        subject: '$JS.API.STREAM.CREATE.ORDERS',
        response: '{"error":{"code":400,"description":"stream name already in use"}}',
      }),
    );
    expect(ok?.severity).toBe('info');
    expect(bad?.severity).toBe('error');
    expect(bad?.title).toContain('$JS.API.STREAM.CREATE.ORDERS');
  });

  it('calls a lost quorum what it is', () => {
    const e = describeEvent(
      msg('$JS.EVENT.ADVISORY.STREAM.QUORUM_LOST.ORDERS', { type: 'io.nats.jetstream.advisory.v1.stream_quorum_lost', stream: 'ORDERS' }),
    );
    expect(e?.severity).toBe('error');
    expect(e?.title).toContain('cannot be written to');
  });

  it('reads the server events of the system account', () => {
    const conn = describeEvent(
      msg('$SYS.ACCOUNT.A.CONNECT', { type: 'io.nats.server.advisory.v1.client_connect', client: { name: 'edge-1' }, server: { name: 'nats-0' } }),
    );
    expect(conn?.title).toBe('edge-1 connected to nats-0');
    const gone = describeEvent(
      msg('$SYS.ACCOUNT.A.DISCONNECT', {
        type: 'io.nats.server.advisory.v1.client_disconnect',
        client: { name: 'edge-1' },
        server: { name: 'nats-0' },
        reason: 'Slow Consumer',
      }),
    );
    // A client the server threw off is not the same as one that said goodbye.
    expect(gone?.severity).toBe('warn');
    expect(gone?.title).toContain('Slow Consumer');
  });

  it('shows an advisory it has never heard of rather than dropping it', () => {
    const e = describeEvent(msg('$JS.EVENT.ADVISORY.STREAM.SOMETHING_NEW.ORDERS', { type: 'io.nats.jetstream.advisory.v1.something_lost', stream: 'ORDERS' }));
    expect(e).not.toBeNull();
    expect(e?.title).toContain('something lost');
    expect(e?.severity).toBe('error');
  });

  it('is not interested in statistics or in ordinary messages', () => {
    expect(describeEvent(msg('$SYS.SERVER.NABC.STATSZ', { type: 'io.nats.server.advisory.v1.server_stats' }))).toBeNull();
    expect(describeEvent(msg('$JS.EVENT.METRIC.CONSUMER.ACK.ORDERS.billing', { type: 'io.nats.jetstream.metric.v1.consumer_ack' }))).toBeNull();
    expect(describeEvent(msg('orders.created', { id: 1 }))).toBeNull();
  });
});

describe('eventsOf', () => {
  it('puts the newest first and counts what is wrong', () => {
    const events = eventsOf([
      msg(ADVISORY, { type: 'io.nats.jetstream.advisory.v1.max_deliver', stream: 'S', consumer: 'c' }, 1000),
      msg('orders.created', { a: 1 }, 2000),
      msg('$JS.EVENT.ADVISORY.STREAM.CREATED.S', { type: 'io.nats.jetstream.advisory.v1.stream_action', action: 'create', stream: 'S' }, 3000),
    ]);
    expect(events.map(e => e.at)).toEqual([3000, 1000]);
    expect(countBySeverity(events)).toEqual({ error: 1, warn: 0, info: 1 });
  });
});
