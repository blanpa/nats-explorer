import { describe, expect, it } from 'vitest';
import type { SubjectEntry } from 'shared';
import { TreeModel, ancestorsOf, flattenTree, isSystemRoot } from './tree';

/** A node entry as the server sends it: own count, subtree total, child count. */
const entry = (s: string, n = 1, t = n, c = 0, extra: Partial<SubjectEntry> = {}): SubjectEntry => ({
  s,
  n,
  r: n / 10,
  t,
  tr: t / 10,
  c,
  p: `${n}`,
  pt: 'json',
  ts: n,
  sz: 1,
  ...extra,
});

describe('TreeModel', () => {
  it('places nodes of one connection and sums over connections', () => {
    const m = new TreeModel();
    m.apply('c1', true, [entry('uns', 0, 5, 2), entry('uns.temp', 3), entry('uns.speed', 2)]);
    m.apply('c2', true, [entry('uns', 0, 4, 1), entry('uns.temp', 4), entry('alerts', 1)]);
    expect(m.roots.map(n => n.segment)).toEqual(['alerts', 'uns']);
    const uns = m.roots[1];
    expect(uns.total).toBe(9);
    expect(uns.totalRate).toBeCloseTo(0.9);
    expect(uns.childCount).toBe(2);
    expect(uns.connIds.sort()).toEqual(['c1', 'c2']);
    const temp = uns.children.find(c => c.segment === 'temp')!;
    expect(temp.messageCount).toBe(7);
    expect(temp.last?.payload).toBe('4'); // newest timestamp wins
    expect(uns.children.find(c => c.segment === 'speed')!.connIds).toEqual(['c1']);
    expect(m.size).toBe(4);
  });

  it('a placeholder parent appears when a child arrives first, and updates in place', () => {
    const m = new TreeModel();
    m.apply('c', false, [entry('a.x.1', 5)]);
    expect(m.roots[0].fullSubject).toBe('a');
    expect(m.roots[0].children[0].children[0].messageCount).toBe(5);
    const a = m.roots[0];
    m.apply('c', false, [entry('a', 7, 12, 1), entry('a.x.1', 5)]);
    expect(m.roots[0]).toBe(a);
    expect(a.messageCount).toBe(7);
    expect(a.total).toBe(12);
  });

  it('removed subjects leave with their subtree; other connections keep theirs', () => {
    const m = new TreeModel();
    m.apply('c1', true, [entry('a', 0, 2, 1), entry('a.x', 0, 2, 1), entry('a.x.1', 2)]);
    m.apply('c2', true, [entry('a', 0, 1, 1), entry('a.y', 1)]);
    m.apply('c1', false, [], ['a.x', 'a.x.1']);
    expect(m.get('a.x')).toBeUndefined();
    expect(m.get('a.x.1')).toBeUndefined();
    expect(m.roots[0].children.map(c => c.segment)).toEqual(['y']);
    expect(m.roots[0].total).toBe(3);
    m.apply('c2', true, []); // c2 replaced by an empty tree
    expect(m.roots[0].total).toBe(2);
    expect(m.roots[0].children).toHaveLength(0);
    m.dropConnection('c1');
    expect(m.roots).toHaveLength(0);
    expect(m.size).toBe(0);
  });

  it('sorts numerically aware on insertion', () => {
    const m = new TreeModel();
    m.apply('c', false, [entry('line-10'), entry('line-2'), entry('line-1')]);
    expect(m.roots.map(n => n.segment)).toEqual(['line-1', 'line-2', 'line-10']);
  });

  it('binary entries have no payload preview', () => {
    const m = new TreeModel();
    m.apply('c', false, [{ s: 'bin', n: 1, r: 0, t: 1, tr: 0, pt: 'binary', ts: 5, sz: 3 }]);
    expect(m.roots[0].last).toEqual({ payload: '', payloadType: 'binary', timestamp: 5, size: 3 });
  });
});

describe('flattenTree', () => {
  const model = () => {
    const m = new TreeModel();
    m.apply('c', true, [entry('alerts', 1), entry('uns', 0, 5, 2), entry('uns.speed', 2), entry('uns.temp', 3), entry('$SYS', 0, 9, 3)]);
    return m;
  };

  it('lists roots and the children of expanded branches with guides', () => {
    const flat = flattenTree(model().roots, { isExpanded: p => p === 'uns', hideSystem: true });
    expect(flat.map(f => f.subject)).toEqual(['alerts', 'uns', 'uns.speed', 'uns.temp']);
    expect(flat[2].depth).toBe(1);
    expect(flat[2].guides).toEqual([false]);
    expect(flat[1].hasChildren).toBe(true);
    expect(flat[1].expanded).toBe(true);
    expect(flattenTree(model().roots, { isExpanded: () => false, hideSystem: true })).toHaveLength(2);
  });

  it('a collapsed branch whose children were not sent still shows a chevron', () => {
    const m = new TreeModel();
    m.apply('c', true, [entry('root', 0, 5, 3)]);
    const flat = flattenTree(m.roots, { isExpanded: () => true, hideSystem: true });
    expect(flat).toHaveLength(1);
    expect(flat[0].hasChildren).toBe(true);
    expect(flat[0].total).toBe(5);
  });

  it('system roots are hidden on request', () => {
    expect(flattenTree(model().roots, { isExpanded: () => false, hideSystem: false }).map(f => f.subject)).toEqual(['$SYS', 'alerts', 'uns']);
    expect(isSystemRoot('$JS')).toBe(true);
    expect(isSystemRoot('_INBOX')).toBe(true);
    expect(isSystemRoot('uns')).toBe(false);
  });

  it('ancestorsOf', () => {
    expect(ancestorsOf('a.b.c')).toEqual(['a', 'a.b']);
    expect(ancestorsOf('a')).toEqual([]);
  });
});
