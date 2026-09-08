import { describe, expect, it } from 'vitest';
import type { WsServerEvent } from 'shared';
import type { FromWorker } from './protocol';
import { FeedCore, MAX_PENDING } from './feedCore';

function harness() {
  const posted: FromWorker[] = [];
  const queue: Array<() => void> = [];
  const core = new FeedCore(
    m => posted.push(m),
    fn => queue.push(fn),
  );
  const run = () => {
    while (queue.length) queue.shift()!();
  };
  const of = <T extends FromWorker['type']>(type: T) => posted.filter((m): m is Extract<FromWorker, { type: T }> => m.type === type);
  const lastTree = () => of('tree')[of('tree').length - 1];
  return { core, posted, run, of, lastTree };
}

const entry = (s: string, n = 1) => ({ s, n, r: 0, t: 0, tr: 0, c: 0 });

describe('FeedCore', () => {
  it('lays the tree out once per batch of updates', () => {
    const h = harness();
    h.core.view = { all: false, paths: ['orders'], filter: '', expr: '', hideSystem: true };
    h.core.handleEvent({ type: 'subject-tree', connId: 'a', full: true, data: [entry('orders'), entry('orders.new'), entry('$SYS')] } as WsServerEvent);
    h.core.handleEvent({ type: 'subject-tree', connId: 'a', data: [entry('orders.paid')] } as WsServerEvent);
    expect(h.of('tree')).toHaveLength(0);
    h.run();
    const trees = h.of('tree');
    expect(trees).toHaveLength(1);
    expect(trees[0].rows.map(r => r.subject)).toEqual(['orders', 'orders.new', 'orders.paid']);
    expect(trees[0].systemCount).toBe(1);
  });

  it('shows system roots when the filter asks for them', () => {
    const h = harness();
    h.core.handleEvent({ type: 'subject-tree', connId: 'a', full: true, data: [entry('$JS.API'), entry('orders')] } as WsServerEvent);
    h.core.view = { all: false, paths: [], filter: '$JS', expr: '', hideSystem: true };
    h.core.layoutTree();
    expect(h.lastTree()?.rows.map(r => r.subject)).toContain('$JS');
  });

  it('coalesces live messages and stamps the connection', () => {
    const h = harness();
    const msg = { subject: 'a.b', payload: 'x', payloadType: 'string', timestamp: 1, size: 1 };
    h.core.handleEvent({ type: 'message-batch', connId: 'c1', data: [msg, msg] } as WsServerEvent);
    h.core.handleEvent({ type: 'message-batch', connId: 'c2', data: [msg] } as WsServerEvent);
    expect(h.of('feed')).toHaveLength(0);
    h.run();
    const feeds = h.of('feed');
    expect(feeds).toHaveLength(1);
    expect(feeds[0].msgs.map(m => m.connId)).toEqual(['c1', 'c1', 'c2']);
  });

  it('keeps only the newest messages when the main thread stalls', () => {
    const h = harness();
    const data = Array.from({ length: MAX_PENDING + 5 }, (_, i) => ({ subject: 's', payload: String(i), payloadType: 'string', timestamp: i, size: 1 }));
    h.core.handleEvent({ type: 'message-batch', connId: 'c', data } as WsServerEvent);
    h.run();
    const msgs = h.of('feed')[0].msgs;
    expect(msgs).toHaveLength(MAX_PENDING);
    expect(msgs[0].payload).toBe('5');
  });

  it('drops the tree of a connection that vanished and forwards the event', () => {
    const h = harness();
    h.core.handleEvent({ type: 'connections', data: [{ id: 'a' }, { id: 'b' }] } as WsServerEvent);
    h.core.handleEvent({ type: 'subject-tree', connId: 'a', full: true, data: [entry('from.a')] } as WsServerEvent);
    h.core.handleEvent({ type: 'subject-tree', connId: 'b', full: true, data: [entry('from.b')] } as WsServerEvent);
    h.core.handleEvent({ type: 'connections', data: [{ id: 'b' }] } as WsServerEvent);
    h.run();
    expect(h.lastTree()?.rows.map(r => r.subject)).toEqual(['from']);
    expect(h.core.model.get('from.a')).toBeUndefined();
    expect(h.of('event')).toHaveLength(2);
    // null slices from Go arrive as an empty list
    h.core.handleEvent({ type: 'connections', data: null } as unknown as WsServerEvent);
    h.run();
    expect(h.lastTree()?.rows).toEqual([]);
  });

  it('starts over on reset', () => {
    const h = harness();
    h.core.handleEvent({ type: 'connections', data: [{ id: 'a' }] } as WsServerEvent);
    h.core.handleEvent({ type: 'subject-tree', connId: 'a', full: true, data: [entry('x')] } as WsServerEvent);
    h.core.reset();
    h.run();
    expect(h.lastTree()?.rows).toEqual([]);
  });
});
