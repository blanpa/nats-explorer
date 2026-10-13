import type { Topology } from 'shared';

/**
 * Where everything goes in the topology picture. Each cluster is a box with
 * its servers on a circle inside, the boxes stand in a row, gateways arc
 * over the row from box to box, and the leaf nodes of a server hang below
 * its box. Plain geometry, so it can be tested without a browser.
 */

export const NODE_R = 16;
const PAD = 48; // inside a cluster box, around the circle of servers
const GAP = 110; // between cluster columns
const LEAF_GAP = 96; // between leaf nodes in their row
const LEAF_DROP = 90; // from the bottom of a box to the row of leaf nodes
const MARGIN = 24;

export type EdgeState = 'ok' | 'warn' | 'down' | 'one-sided';

export interface LaidCluster {
  name: string;
  /** a server that is in no cluster gets a box of its own */
  standalone: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  /** a cluster known only as the far end of a gateway */
  unseen: boolean;
}

export interface LaidNode {
  id: string;
  label: string;
  kind: 'server' | 'peer' | 'leaf';
  cluster?: string;
  x: number;
  y: number;
}

export interface LaidEdge {
  key: string;
  kind: 'route' | 'gateway' | 'leaf';
  /** node ids for routes and leafs, cluster names for gateways */
  a: string;
  b: string;
  d: string;
  state: EdgeState;
  /** where a label can sit, the middle of the path */
  mx: number;
  my: number;
  label?: string;
}

export interface TopologyLayout {
  width: number;
  height: number;
  clusters: LaidCluster[];
  nodes: LaidNode[];
  edges: LaidEdge[];
}

function clusterKey(cluster: string | undefined, id: string): string {
  return cluster ? cluster : `\u0000${id}`;
}

export function layoutTopology(t: Topology): TopologyLayout {
  const leafNames = new Set(t.leafs.map(l => l.name));
  const hubOf = new Map<string, string>();
  for (const l of t.leafs) if (!hubOf.has(l.name)) hubOf.set(l.name, l.server);

  // Clusters and their members, leaf nodes aside.
  const members = new Map<string, string[]>();
  const nodeById = new Map(t.nodes.map(n => [n.id, n]));
  // A leaf node hangs below its hub, unless it is a server of a cluster of
  // its own that answered for itself: then it is that cluster's box.
  const inRow = (id: string) => {
    const n = nodeById.get(id);
    return leafNames.has(id) && !(n?.kind === 'server' && n.cluster);
  };
  for (const n of t.nodes) {
    if (inRow(n.id)) continue;
    const k = clusterKey(n.cluster, n.id);
    if (!members.has(k)) members.set(k, []);
    members.get(k)!.push(n.id);
  }
  // A gateway to a cluster nobody of which answered or connected still has
  // an end to draw to.
  const unseen = new Set<string>();
  for (const g of t.gateways) {
    if (!members.has(g.remote)) {
      members.set(g.remote, []);
      unseen.add(g.remote);
    }
  }
  const keys = [...members.keys()].sort((a, b) => {
    // The biggest cluster first, the way people draw a hub and its spokes.
    const d = members.get(b)!.length - members.get(a)!.length;
    return d !== 0 ? d : a.localeCompare(b);
  });

  // Leaf nodes per cluster, in the order of their hubs.
  const leafsOfCluster = new Map<string, string[]>();
  for (const name of [...leafNames].filter(inRow).sort()) {
    const hub = nodeById.get(hubOf.get(name) ?? '');
    const k = clusterKey(hub?.cluster, hub?.id ?? '');
    if (!leafsOfCluster.has(k)) leafsOfCluster.set(k, []);
    leafsOfCluster.get(k)!.push(name);
  }

  // Box sizes first, so the arcs know how high the row has to start.
  const sized = keys.map(k => {
    const n = members.get(k)!.length;
    const r = n <= 1 ? 0 : Math.max(44, (n * (NODE_R * 2 + 26)) / (2 * Math.PI));
    const box = Math.max(150, 2 * r + 2 * PAD + 20);
    const leafs = leafsOfCluster.get(k) ?? [];
    const col = Math.max(box, leafs.length * LEAF_GAP);
    return { k, n, r, box, col, leafs };
  });
  let x = MARGIN;
  const centers = new Map<string, number>();
  for (const s of sized) {
    centers.set(s.k, x + s.col / 2);
    x += s.col + GAP;
  }
  const width = Math.max(x - GAP + MARGIN, 320);

  // Gateway pairs, unordered.
  const pairs = new Map<string, { a: string; b: string; states: EdgeState[]; count: number }>();
  for (const g of t.gateways) {
    if (g.cluster === g.remote) continue;
    const [a, b] = [g.cluster, g.remote].sort();
    const key = `${a}\u0000${b}`;
    if (!pairs.has(key)) pairs.set(key, { a, b, states: [], count: 0 });
    const p = pairs.get(key)!;
    p.count++;
    p.states.push(!g.connected ? 'down' : g.pending > 0 ? 'warn' : 'ok');
  }
  const arcHeight = (a: string, b: string) => 46 + Math.abs((centers.get(a) ?? 0) - (centers.get(b) ?? 0)) * 0.14;
  const topRoom = Math.max(0, ...[...pairs.values()].map(p => arcHeight(p.a, p.b)));
  const top = MARGIN + (pairs.size ? topRoom + 12 : 0);
  const tallest = Math.max(0, ...sized.map(s => s.box));

  const clusters: LaidCluster[] = [];
  const nodes: LaidNode[] = [];
  const pos = new Map<string, { x: number; y: number }>();
  let bottom = top + tallest;
  for (const s of sized) {
    const cx = centers.get(s.k)!;
    const y = top + (tallest - s.box) / 2;
    const standalone = s.k.startsWith('\u0000');
    clusters.push({ name: standalone ? '' : s.k, standalone, x: cx - s.box / 2, y, w: s.box, h: s.box, unseen: unseen.has(s.k) });
    const ids = [...members.get(s.k)!].sort();
    const cy = y + s.box / 2 + 6;
    ids.forEach((id, i) => {
      const angle = -Math.PI / 2 + (i / ids.length) * 2 * Math.PI;
      const p = { x: cx + s.r * Math.cos(angle), y: cy + s.r * Math.sin(angle) };
      pos.set(id, p);
      const n = nodeById.get(id)!;
      nodes.push({ id, label: n.name, kind: n.kind, cluster: n.cluster, ...p });
    });
    const ly = y + s.box + LEAF_DROP;
    s.leafs.forEach((name, i) => {
      const p = { x: cx + (i - (s.leafs.length - 1) / 2) * LEAF_GAP, y: ly };
      pos.set(name, p);
      const n = nodeById.get(name);
      nodes.push({ id: name, label: n?.name ?? name, kind: 'leaf', ...p });
      bottom = Math.max(bottom, ly + NODE_R + 30);
    });
  }

  const edges: LaidEdge[] = [];
  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => `M${a.x.toFixed(1)},${a.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`;

  // Routes, one line per pair of servers whichever side reported them.
  const routePairs = new Map<string, { a: string; b: string; sides: Set<string>; pending: number }>();
  for (const r of t.routes) {
    const [a, b] = [r.server, r.remote].sort();
    const key = `${a}\u0000${b}`;
    if (!routePairs.has(key)) routePairs.set(key, { a, b, sides: new Set(), pending: 0 });
    const p = routePairs.get(key)!;
    p.sides.add(r.server);
    p.pending += r.pending;
  }
  for (const [key, p] of routePairs) {
    const pa = pos.get(p.a);
    const pb = pos.get(p.b);
    if (!pa || !pb) continue;
    edges.push({
      key: `route:${key}`,
      kind: 'route',
      a: p.a,
      b: p.b,
      d: line(pa, pb),
      state: p.pending > 0 ? 'warn' : p.sides.size < 2 ? 'one-sided' : 'ok',
      mx: (pa.x + pb.x) / 2,
      my: (pa.y + pb.y) / 2,
    });
  }

  // Gateways arc from the top of one box to the top of the other.
  const boxOf = new Map(clusters.filter(c => !c.standalone).map(c => [c.name, c]));
  for (const [key, p] of pairs) {
    const ca = boxOf.get(p.a);
    const cb = boxOf.get(p.b);
    if (!ca || !cb) continue;
    const ax = ca.x + ca.w / 2;
    const bx = cb.x + cb.w / 2;
    const ay = ca.y;
    const by = cb.y;
    const peak = Math.min(ay, by) - arcHeight(p.a, p.b) * 2;
    const mx = (ax + bx) / 2;
    const state: EdgeState = p.states.includes('down') ? 'down' : p.states.includes('warn') ? 'warn' : 'ok';
    edges.push({
      key: `gateway:${key}`,
      kind: 'gateway',
      a: p.a,
      b: p.b,
      d: `M${ax.toFixed(1)},${ay.toFixed(1)} Q${mx.toFixed(1)},${peak.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`,
      state,
      mx,
      // the middle of a quadratic curve is half way to its control point
      my: (ay + by) / 4 + peak / 2,
      label: `${p.count} conn${p.count === 1 ? '' : 's'}`,
    });
  }

  // Leaf connections, from the hub down.
  for (const l of t.leafs) {
    const pa = pos.get(l.server);
    const pb = pos.get(l.name);
    if (!pa || !pb) continue;
    edges.push({
      key: `leaf:${l.server}\u0000${l.name}\u0000${l.account}`,
      kind: 'leaf',
      a: l.server,
      b: l.name,
      d: line(pa, pb),
      state: 'ok',
      mx: (pa.x + pb.x) / 2,
      my: (pa.y + pb.y) / 2,
      label: l.account,
    });
  }

  return { width, height: bottom + MARGIN, clusters, nodes, edges };
}

/** An RTT as the server writes it ("1.18ms", "65µs", "2s") in milliseconds. */
export function rttMs(rtt?: string): number | null {
  if (!rtt) return null;
  const m = /^([\d.]+)(ns|µs|us|ms|s)$/.exec(rtt.trim());
  if (!m) return null;
  const v = Number(m[1]);
  return m[2] === 's' ? v * 1000 : m[2] === 'ms' ? v : m[2] === 'ns' ? v / 1e6 : v / 1000;
}
