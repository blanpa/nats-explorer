import { describe, expect, it } from 'vitest';
import type { Topology } from 'shared';
import { layoutTopology, rttMs } from './topologyLayout';

const traffic = { inMsgs: 0, outMsgs: 0, inBytes: 0, outBytes: 0 };

function topo(over: Partial<Topology>): Topology {
  return { source: 'system', nodes: [], routes: [], gateways: [], leafs: [], errors: [], ...over };
}

describe('layoutTopology', () => {
  const t = topo({
    nodes: [
      { id: 'hub-a', name: 'hub-a', cluster: 'hub', kind: 'server' },
      { id: 'hub-b', name: 'hub-b', cluster: 'hub', kind: 'server' },
      { id: 'edge-a', name: 'edge-a', cluster: 'edge', kind: 'server' },
      { id: 'leaf-1', name: 'leaf-1', kind: 'leaf', account: 'APP' },
    ],
    routes: [
      { server: 'hub-a', remote: 'hub-b', connections: 3, rtt: '1ms', pending: 0, subscriptions: 1, configured: true, ...traffic },
      { server: 'hub-b', remote: 'hub-a', connections: 3, rtt: '1ms', pending: 0, subscriptions: 1, configured: true, ...traffic },
    ],
    gateways: [
      { server: 'hub-a', cluster: 'hub', remote: 'edge', direction: 'outbound', configured: true, connected: true, pending: 0, subscriptions: 0, ...traffic },
      { server: 'edge-a', cluster: 'edge', remote: 'far', direction: 'outbound', configured: true, connected: false, pending: 0, subscriptions: 0, ...traffic },
    ],
    leafs: [{ server: 'hub-b', name: 'leaf-1', account: 'APP', address: '10.0.0.1:1', rtt: '2ms', spoke: false, subscriptions: 0, ...traffic }],
  });
  const lay = layoutTopology(t);

  it('draws one box per cluster, with the biggest first and an unreached gateway end', () => {
    expect(lay.clusters.map(c => [c.name, c.unseen])).toEqual([
      ['hub', false],
      ['edge', false],
      ['far', true],
    ]);
    const [hub, edge] = lay.clusters;
    expect(hub.x + hub.w).toBeLessThan(edge.x);
  });

  it('puts the servers inside their box and the leaf node below it', () => {
    const hub = lay.clusters[0];
    for (const id of ['hub-a', 'hub-b']) {
      const n = lay.nodes.find(x => x.id === id)!;
      expect(n.x).toBeGreaterThan(hub.x);
      expect(n.x).toBeLessThan(hub.x + hub.w);
      expect(n.y).toBeGreaterThan(hub.y);
      expect(n.y).toBeLessThan(hub.y + hub.h);
    }
    const leaf = lay.nodes.find(x => x.id === 'leaf-1')!;
    expect(leaf.kind).toBe('leaf');
    expect(leaf.y).toBeGreaterThan(hub.y + hub.h);
  });

  it('draws a route once for both of its sides, and marks a gateway that is down', () => {
    expect(lay.edges.filter(e => e.kind === 'route')).toHaveLength(1);
    expect(lay.edges.find(e => e.kind === 'route')!.state).toBe('ok');
    const gws = lay.edges.filter(e => e.kind === 'gateway');
    expect(gws.map(e => [e.a, e.b, e.state])).toEqual([
      ['edge', 'hub', 'ok'],
      ['edge', 'far', 'down'],
    ]);
    expect(lay.edges.filter(e => e.kind === 'leaf').map(e => [e.a, e.b])).toEqual([['hub-b', 'leaf-1']]);
  });

  it('marks a route only one end reported', () => {
    const one = layoutTopology(topo({ ...t, routes: [t.routes[0]] }));
    expect(one.edges.find(e => e.kind === 'route')!.state).toBe('one-sided');
  });

  it('keeps a server outside any cluster in a box of its own', () => {
    const single = layoutTopology(topo({ nodes: [{ id: 'solo', name: 'solo', kind: 'server' }] }));
    expect(single.clusters).toHaveLength(1);
    expect(single.clusters[0].standalone).toBe(true);
    expect(single.nodes[0].id).toBe('solo');
  });
});

describe('rttMs', () => {
  it('reads the units the server writes', () => {
    expect(rttMs('65µs')).toBeCloseTo(0.065);
    expect(rttMs('1.5ms')).toBe(1.5);
    expect(rttMs('2s')).toBe(2000);
    expect(rttMs('')).toBeNull();
    expect(rttMs('soon')).toBeNull();
  });
});
