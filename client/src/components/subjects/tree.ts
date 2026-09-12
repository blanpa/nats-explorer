import type { PayloadType, SubjectEntry } from 'shared';

/**
 * The subject tree as the browser shows it. The server keeps the hierarchy
 * and its aggregates and sends only the nodes visible in this tab's view
 * (see the `view` websocket command); the browser merges the nodes of all
 * connections by subject and lays them out.
 */
export interface TreeNode {
  segment: string;
  fullSubject: string;
  /** messages on exactly this subject, summed over connections */
  messageCount: number;
  /** messages in the whole subtree */
  total: number;
  rate: number;
  /** rate of this node plus every descendant */
  totalRate: number;
  /** children the server knows of; the received ones are in `children` */
  childCount: number;
  /** subjects with at least one message in the subtree, this node included */
  subjects: number;
  /** newest last-message preview across connections */
  last?: { payload: string; payloadType: PayloadType; timestamp: number; size: number };
  children: TreeNode[];
  connIds: string[];
  parent?: TreeNode;
  byConn: Map<string, SubjectEntry>;
}

/** One rendered row. Plain data so it can cross a worker boundary. */
export interface FlatNode {
  subject: string;
  segment: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** for each ancestor level: whether a vertical guide line continues */
  guides: boolean[];
  total: number;
  rate: number;
  totalRate: number;
  /** subjects with messages in the subtree, this node included */
  subjects: number;
  last?: TreeNode['last'];
  connIds: string[];
}

const bySegment = (a: TreeNode, b: TreeNode) => a.segment.localeCompare(b.segment, undefined, { numeric: true });

function newNode(segment: string, fullSubject: string, parent?: TreeNode): TreeNode {
  return {
    segment,
    fullSubject,
    messageCount: 0,
    total: 0,
    rate: 0,
    totalRate: 0,
    childCount: 0,
    subjects: 0,
    children: [],
    connIds: [],
    parent,
    byConn: new Map(),
  };
}

/** Index of the position at which node belongs in a sorted sibling list. */
function insertionIndex(list: TreeNode[], node: TreeNode): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bySegment(list[mid], node) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Merged view over the node entries of all connections. Nodes are mutated in
 * place; the owner bumps a version to re-render. Applying an entry is O(1)
 * apart from creating a missing path.
 */
export class TreeModel {
  roots: TreeNode[] = [];
  private nodes = new Map<string, TreeNode>();

  get size(): number {
    return this.nodes.size;
  }

  get(subject: string): TreeNode | undefined {
    return this.nodes.get(subject);
  }

  /** Applies a tree update of one connection. */
  apply(connId: string, full: boolean, entries: SubjectEntry[], removed: string[] = []): void {
    if (full) this.dropConnection(connId);
    for (const s of removed) this.removeEntry(connId, s);
    for (const e of entries) this.applyEntry(connId, e);
  }

  /** Forgets everything a connection contributed. */
  dropConnection(connId: string): void {
    for (const node of [...this.nodes.values()]) {
      if (node.byConn.has(connId)) this.removeEntry(connId, node.fullSubject);
    }
  }

  private applyEntry(connId: string, e: SubjectEntry): void {
    const node = this.nodes.get(e.s) ?? this.insert(e.s);
    node.byConn.set(connId, e);
    this.recompute(node);
    if (!node.connIds.includes(connId)) node.connIds.push(connId);
  }

  private recompute(node: TreeNode): void {
    let count = 0;
    let total = 0;
    let rate = 0;
    let totalRate = 0;
    let childCount = 0;
    let subjects = 0;
    let last: TreeNode['last'];
    for (const c of node.byConn.values()) {
      count += c.n ?? 0;
      total += c.t ?? 0;
      rate += c.r ?? 0;
      totalRate += c.tr ?? 0;
      childCount = Math.max(childCount, c.c ?? 0);
      // The same subject on two connections is one subject, so the largest
      // connection wins instead of the sum.
      subjects = Math.max(subjects, c.sc ?? 0);
      if (c.ts && (!last || c.ts > last.timestamp)) last = { payload: c.p ?? '', payloadType: c.pt ?? 'string', timestamp: c.ts, size: c.sz ?? 0 };
    }
    node.messageCount = count;
    node.total = total;
    node.rate = rate;
    node.totalRate = totalRate;
    node.childCount = childCount;
    node.subjects = subjects;
    node.last = last;
  }

  private removeEntry(connId: string, subject: string): void {
    const node = this.nodes.get(subject);
    if (!node?.byConn.delete(connId)) return;
    node.connIds = node.connIds.filter(id => id !== connId);
    if (node.byConn.size > 0) {
      this.recompute(node);
      return;
    }
    // Nothing left from any connection: drop the node and whatever hangs below it.
    for (const child of [...node.children]) for (const id of child.connIds) this.removeEntry(id, child.fullSubject);
    if (node.byConn.size > 0 || node.children.length > 0) return; // placeholder kept by children of other connections
    this.detach(node);
  }

  private detach(node: TreeNode): void {
    const siblings = node.parent ? node.parent.children : this.roots;
    const i = siblings.indexOf(node);
    if (i >= 0) siblings.splice(i, 1);
    this.nodes.delete(node.fullSubject);
    // A placeholder parent that only existed for this child goes too.
    const p = node.parent;
    if (p && p.byConn.size === 0 && p.children.length === 0) this.detach(p);
  }

  private insert(fullSubject: string): TreeNode {
    const segments = fullSubject.split('.');
    let parent: TreeNode | undefined;
    let full = '';
    let node: TreeNode | undefined;
    for (let i = 0; i < segments.length; i++) {
      full = i === 0 ? segments[i] : `${full}.${segments[i]}`;
      node = this.nodes.get(full);
      if (!node) {
        node = newNode(segments[i], full, parent);
        const siblings = parent ? parent.children : this.roots;
        siblings.splice(insertionIndex(siblings, node), 0, node);
        this.nodes.set(full, node);
      }
      parent = node;
    }
    return node!;
  }
}

export interface FlattenOptions {
  isExpanded: (path: string) => boolean;
  /** hide _INBOX and $-prefixed roots */
  hideSystem: boolean;
}

/** Lays the received nodes out as rows: roots, then the children of expanded branches. */
export function flattenTree(roots: TreeNode[], opts: FlattenOptions): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (list: TreeNode[], depth: number, guides: boolean[]) => {
    list.forEach((node, i) => {
      const hasChildren = node.childCount > 0 || node.children.length > 0;
      const expanded = hasChildren && opts.isExpanded(node.fullSubject);
      out.push({
        subject: node.fullSubject,
        segment: node.segment,
        depth,
        hasChildren,
        expanded,
        guides,
        total: node.total,
        rate: node.rate,
        totalRate: node.totalRate,
        subjects: node.subjects,
        last: node.last,
        connIds: node.connIds,
      });
      if (expanded && node.children.length) walk(node.children, depth + 1, [...guides, i < list.length - 1]);
    });
  };
  walk(opts.hideSystem ? roots.filter(n => !isSystemRoot(n.segment)) : roots, 0, []);
  return out;
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
