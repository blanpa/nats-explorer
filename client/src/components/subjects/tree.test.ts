import { describe, expect, it } from 'vitest';
import type { SubjectEntry } from 'shared';
import { ancestorsOf, buildTree, collectBranchPaths, filterTree, flattenTree, type SubjectIndex } from './tree';

const entry = (s: string, n = 1, r = 0, ts = n): SubjectEntry => ({ s, n, r, p: `${n}`, pt: 'json', ts, sz: 1 });
const index = (...conns: [string, SubjectEntry[]][]): SubjectIndex => new Map(conns.map(([id, list]) => [id, new Map(list.map(e => [e.s, e]))]));

const connA: SubjectEntry[] = [entry('uns.temp', 3, 1), entry('uns.speed', 2, 0.5)];
const connB: SubjectEntry[] = [entry('uns.temp', 4, 2), entry('alerts', 1)];

describe('buildTree', () => {
  it('rebuilds the hierarchy across connections and sums counts and rates', () => {
    const merged = buildTree(index(['c1', connA], ['c2', connB]));
    expect(merged.map(n => n.segment)).toEqual(['alerts', 'uns']);
    const uns = merged[1];
    expect(uns.fullSubject).toBe('uns');
    expect(uns.messageCount).toBe(0);
    expect(uns.total).toBe(9);
    expect(uns.totalRate).toBeCloseTo(3.5);
    expect(uns.connIds.sort()).toEqual(['c1', 'c2']);
    const temp = uns.children.find(c => c.segment === 'temp')!;
    expect(temp.messageCount).toBe(7);
    expect(temp.rate).toBe(3);
    expect(temp.last?.payload).toBe('4'); // newest timestamp wins
    expect(uns.children.find(c => c.segment === 'speed')!.connIds).toEqual(['c1']);
  });

  it('a subject can carry messages and children at once', () => {
    const t = buildTree(index(['c', [entry('a', 7), entry('a.x.1', 5), entry('a.x.2', 1)]]));
    expect(t[0].messageCount).toBe(7);
    expect(t[0].total).toBe(13);
    expect(t[0].children[0].fullSubject).toBe('a.x');
    expect(t[0].children[0].messageCount).toBe(0);
    expect(t[0].children[0].children.map(c => c.fullSubject)).toEqual(['a.x.1', 'a.x.2']);
  });

  it('sorts numerically aware', () => {
    const t = buildTree(index(['c', [entry('line-10'), entry('line-2'), entry('line-1')]]));
    expect(t.map(n => n.segment)).toEqual(['line-1', 'line-2', 'line-10']);
  });

  it('binary entries have no payload preview', () => {
    const t = buildTree(index(['c', [{ s: 'bin', n: 1, r: 0, pt: 'binary', ts: 5, sz: 3 }]]));
    expect(t[0].last).toEqual({ payload: '', payloadType: 'binary', timestamp: 5, size: 3 });
  });
});

describe('filterTree / flattenTree', () => {
  const merged = buildTree(index(['c1', connA], ['c2', connB]));

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
