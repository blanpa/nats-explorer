// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { eventLine } from './ConnectionLog';

describe('eventLine', () => {
  it('writes an event the way the server logs it', () => {
    const at = Date.UTC(2026, 9, 20, 14, 2, 11);
    expect(eventLine({ at, link: 'live', kind: 'reason', server: 'nats://nats-1:4222', cid: 42, detail: 'Slow Consumer (Pending Bytes)' })).toBe(
      '2026-10-20T14:02:11.000Z [live] reason nats://nats-1:4222 cid 42: Slow Consumer (Pending Bytes)',
    );
    expect(eventLine({ at, link: 'api', kind: 'closed' })).toBe('2026-10-20T14:02:11.000Z [api] closed');
  });
});
