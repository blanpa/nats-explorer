import { describe, expect, it } from 'vitest';
import type { SubjectNode } from 'shared';
import { ancestorsOf, collectBranchPaths, filterTree, flattenTree, mergeTrees } from './tree';

const leaf = (segment: string, full: string, count = 1, rate = 0): SubjectNode => ({
  segment,
  fullSubject: full,
  messageCount: count,
  rate,
  children: [],
  lastMessage: { subject: full, payload: `${count}`, payloadType: 'json', timestamp: count, size: 1 },
});

const treeA: SubjectNode[] = [
  {
    segment: 'uns',
    fullSubject: 'uns',
    messageCount: 0,
    rate: 0,
    children: [leaf('temp', 'uns.temp', 3, 1), leaf('speed', 'uns.speed', 2, 0.5)],
  },
];
const treeB: SubjectNode[] = [
  { segment: 'uns', fullSubject: 'uns', messageCount: 0, rate: 0, children: [leaf('temp', 'uns.temp', 4, 2)] },
  leaf('alerts', 'alerts', 1),
];

describe('mergeTrees', () => {
  it('merges nodes across connections and sums counts and rates', () => {
    const merged = mergeTrees(new Map([['c1', treeA], ['c2', treeB]]));
    expect(merged.map(n => n.segment)).toEqual(['alerts', 'uns']);
    const uns = merged[1];
    expect(uns.total).toBe(9);
    expect(uns.totalRate).toBeCloseTo(3.5);
    expect(uns.connIds.sort()).toEqual(['c1', 'c2']);
    const temp = uns.children.find(c => c.segment === 'temp')!;
    expect(temp.messageCount).toBe(7);
    expect(temp.rate).toBe(3);
    expect(temp.lastMessage?.payload).toBe('4'); // newest timestamp wins
    expect(uns.children.find(c => c.segment === 'speed')!.connIds).toEqual(['c1']);
  });

  it('sorts numerically aware', () => {
    const t: SubjectNode[] = [leaf('line-10', 'line-10'), leaf('line-2', 'line-2'), leaf('line-1', 'line-1')];
    expect(mergeTrees(new Map([['c', t]])).map(n => n.segment)).toEqual(['line-1', 'line-2', 'line-10']);
  });
});

describe('filterTree / flattenTree', () => {
  const merged = mergeTrees(new Map([['c1', treeA], ['c2', treeB]]));

  it('keeps ancestors of matches and drops the rest', () => {
    const f = filterTree(merged, 'speed');
    expect(f).toHaveLength(1);
    expect(f[0].segment).toBe('uns');
    expect(f[0].children.map(c => c.segment)).toEqual(['speed']);
  });

  it('matching a branch keeps its whole subtree', () => {
    const f = filterTree(merged, 'uns');
    expect(f[0].children).toHaveLength(2);
  });

  it('combines multiple terms', () => {
    expect(filterTree(merged, 'uns temp')[0].children.map(c => c.segment)).toEqual(['temp']);
    expect(filterTree(merged, 'uns nope')).toHaveLength(0);
  });

  it('flattens respecting the expanded set and computes guides', () => {
    const flat = flattenTree(merged, p => p === 'uns');
    expect(flat.map(f => f.node.fullSubject)).toEqual(['alerts', 'uns', 'uns.speed', 'uns.temp']);
    expect(flat[2].depth).toBe(1);
    expect(flat[2].guides).toEqual([false]);
    expect(flattenTree(merged, () => false)).toHaveLength(2);
  });

  it('collectBranchPaths and ancestorsOf', () => {
    expect(collectBranchPaths(merged)).toEqual(['uns']);
    expect(ancestorsOf('a.b.c')).toEqual(['a', 'a.b']);
    expect(ancestorsOf('a')).toEqual([]);
  });
});
