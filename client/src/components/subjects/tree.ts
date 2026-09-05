import type { SubjectNode } from 'shared';

/** Merged, annotated tree node used by the explorer. */
export interface TreeNode {
  segment: string;
  fullSubject: string;
  messageCount: number;
  total: number;
  rate: number;
  /** rate of this node plus every descendant */
  totalRate: number;
  lastMessage?: SubjectNode['lastMessage'];
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

function mergeInto(level: Map<string, TreeNode>, node: SubjectNode, connId: string) {
  const existing = level.get(node.segment);
  if (!existing) {
    const created: TreeNode = {
      segment: node.segment,
      fullSubject: node.fullSubject,
      messageCount: node.messageCount,
      total: 0,
      rate: node.rate,
      totalRate: 0,
      lastMessage: node.lastMessage,
      children: [],
      connIds: [connId],
    };
    level.set(node.segment, created);
    const childMap = new Map<string, TreeNode>();
    for (const c of node.children) mergeInto(childMap, c, connId);
    created.children = [...childMap.values()].sort(bySegment);
    created.total = created.messageCount + created.children.reduce((s, c) => s + c.total, 0);
    created.totalRate = created.rate + created.children.reduce((s, c) => s + c.totalRate, 0);
    return;
  }
  existing.messageCount += node.messageCount;
  existing.rate += node.rate;
  if (!existing.connIds.includes(connId)) existing.connIds.push(connId);
  if (node.lastMessage && (!existing.lastMessage || node.lastMessage.timestamp > existing.lastMessage.timestamp)) {
    existing.lastMessage = node.lastMessage;
  }
  const childMap = new Map<string, TreeNode>(existing.children.map(c => [c.segment, c]));
  for (const c of node.children) mergeInto(childMap, c, connId);
  existing.children = [...childMap.values()].sort(bySegment);
  existing.total = existing.messageCount + existing.children.reduce((s, c) => s + c.total, 0);
  existing.totalRate = existing.rate + existing.children.reduce((s, c) => s + c.totalRate, 0);
}

const bySegment = (a: TreeNode, b: TreeNode) => a.segment.localeCompare(b.segment, undefined, { numeric: true });

export function mergeTrees(trees: Map<string, SubjectNode[]>): TreeNode[] {
  const root = new Map<string, TreeNode>();
  for (const [connId, tree] of trees) for (const n of tree) mergeInto(root, n, connId);
  return [...root.values()].sort(bySegment);
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
