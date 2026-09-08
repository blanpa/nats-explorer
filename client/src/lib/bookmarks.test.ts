// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { type Bookmark, byGroup, findBookmark, groupsOf, useBookmarks } from './bookmarks';

const mark = (subject: string, group?: string, label?: string): Bookmark => ({ subject, group, label, createdAt: 1 });

beforeEach(() => {
  localStorage.clear();
  useBookmarks.setState({ items: [] });
});

describe('bookmark helpers', () => {
  it('finds a bookmark by subject', () => {
    const items = [mark('a.b'), mark('c.d')];
    expect(findBookmark(items, 'c.d')?.subject).toBe('c.d');
    expect(findBookmark(items, 'nope')).toBeUndefined();
    expect(findBookmark(items, null)).toBeUndefined();
  });

  it('lists the groups in use, sorted and without blanks', () => {
    expect(groupsOf([mark('a', 'Line 3'), mark('b'), mark('c', ' '), mark('d', 'Line 1'), mark('e', 'Line 3')])).toEqual(['Line 1', 'Line 3']);
  });

  it('groups bookmarks and keeps the ungrouped ones last', () => {
    const grouped = byGroup([mark('z', undefined, 'Zeta'), mark('a', 'Line 1'), mark('b', 'Line 1', 'Alpha'), mark('y')]);
    expect(grouped.map(([g]) => g)).toEqual(['Line 1', '']);
    // sorted by what is shown: the bare subject "a" sorts before the label "Alpha"
    expect(grouped[0][1].map(b => b.subject)).toEqual(['a', 'b']);
    expect(grouped[1][1].map(b => b.subject)).toEqual(['y', 'z']);
  });
});

describe('bookmark store', () => {
  it('toggles a subject on and off and persists it', () => {
    useBookmarks.getState().toggle('plant.line1.temp');
    expect(useBookmarks.getState().items).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('ne.bookmarks.v1') ?? '[]')).toHaveLength(1);
    useBookmarks.getState().toggle('plant.line1.temp');
    expect(useBookmarks.getState().items).toHaveLength(0);
  });

  it('saves a label, group and note, and updates in place', () => {
    const store = useBookmarks.getState();
    store.save({ subject: 'a.b', label: 'Oven', group: 'Line 1', note: 'watch this', createdAt: 1 });
    store.save({ subject: 'a.b', label: 'Oven 2', createdAt: 1 });
    const items = useBookmarks.getState().items;
    expect(items).toHaveLength(1);
    // save replaces the whole bookmark, so the old group is gone
    expect(items[0].label).toBe('Oven 2');
    expect(items[0].group).toBeUndefined();
  });

  it('reads what was stored before', () => {
    localStorage.setItem('ne.bookmarks.v1', JSON.stringify([mark('kept'), { nonsense: true }]));
    useBookmarks.getState().reload();
    expect(useBookmarks.getState().items.map(b => b.subject)).toEqual(['kept']);
  });
});
