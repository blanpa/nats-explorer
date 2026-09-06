import type { PayloadType, SubjectEntry } from 'shared';

/** Merged, annotated tree node used by the explorer. */
export interface TreeNode {
  segment: string;
  fullSubject: string;
  messageCount: number;
  total: number;
  rate: number;
  /** rate of this node plus every descendant */
  totalRate: number;
  /** newest last-message preview across connections */
  last?: { payload: string; payloadType: PayloadType; timestamp: number; size: number };
  children: TreeNode[];
  connIds: string[];
}

export interface FlatNode {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** for each ancestor level: whether a vertical guide line continues */
  guides: boolean[];
}

/** Flat per-connection subject index as maintained by the store. */
export type SubjectIndex = Map<string, Map<string, SubjectEntry>>;

const bySegment = (a: TreeNode, b: TreeNode) => a.segment.localeCompare(b.segment, undefined, { numeric: true });

interface Building {
  node: TreeNode;
  children: Map<string, Building>;
}

/**
 * Builds the merged hierarchy from the flat indexes of all connections in one
 * pass: O(subjects × depth), with a single sort per level at the end.
 */
export function buildTree(index: SubjectIndex): TreeNode[] {
  const root = new Map<string, Building>();
  for (const [connId, entries] of index) {
    for (const e of entries.values()) {
      const segments = e.s.split('.');
      let level = root;
      let full = '';
      let b: Building | undefined;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        full = i === 0 ? seg : `${full}.${seg}`;
        b = level.get(seg);
        if (!b) {
          b = { node: { segment: seg, fullSubject: full, messageCount: 0, total: 0, rate: 0, totalRate: 0, children: [], connIds: [] }, children: new Map() };
          level.set(seg, b);
        }
        level = b.children;
      }
      const node = b!.node;
      node.messageCount += e.n;
      node.rate += e.r;
      if (!node.connIds.includes(connId)) node.connIds.push(connId);
      if (e.ts && (!node.last || e.ts > node.last.timestamp)) {
        node.last = { payload: e.p ?? '', payloadType: e.pt ?? 'string', timestamp: e.ts, size: e.sz ?? 0 };
      }
    }
  }
  return finish(root);
}

function finish(level: Map<string, Building>): TreeNode[] {
  const out: TreeNode[] = [];
  for (const b of level.values()) {
    const n = b.node;
    n.children = finish(b.children);
    n.total = n.messageCount;
    n.totalRate = n.rate;
    for (const c of n.children) {
      n.total += c.total;
      n.totalRate += c.totalRate;
      for (const id of c.connIds) if (!n.connIds.includes(id)) n.connIds.push(id);
    }
    out.push(n);
  }
  return out.sort(bySegment);
}

/** Keeps nodes whose subject matches the filter, plus all their ancestors and descendants. */
export function filterTree(nodes: TreeNode[], filter: string): TreeNode[] {
  const q = filter.trim().toLowerCase();
  if (!q) return nodes;
  const terms = q.split(/\s+/);
  const matches = (s: string) => terms.every(t => s.includes(t));
  const walk = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const n of list) {
      if (matches(n.fullSubject.toLowerCase())) {
        out.push(n);
        continue;
      }
      const kids = walk(n.children);
      if (kids.length) out.push({ ...n, children: kids });
    }
    return out;
  };
  return walk(nodes);
}

export function flattenTree(nodes: TreeNode[], isExpanded: (path: string) => boolean): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (list: TreeNode[], depth: number, guides: boolean[]) => {
    list.forEach((node, i) => {
      const hasChildren = node.children.length > 0;
      const expanded = hasChildren && isExpanded(node.fullSubject);
      out.push({ node, depth, hasChildren, expanded, guides });
      if (expanded) walk(node.children, depth + 1, [...guides, i < list.length - 1]);
    });
  };
  walk(nodes, 0, []);
  return out;
}

export function collectBranchPaths(nodes: TreeNode[], into: string[] = []): string[] {
  for (const n of nodes) {
    if (n.children.length) {
      into.push(n.fullSubject);
      collectBranchPaths(n.children, into);
    }
  }
  return into;
}

export function ancestorsOf(subject: string): string[] {
  const parts = subject.split('.');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('.'));
  return out;
}

/** NATS-internal roots: request inboxes, JetStream/KV/object-store/service/system traffic. */
export function isSystemRoot(segment: string): boolean {
  return segment === '_INBOX' || segment.startsWith('$');
}
