import { create } from 'zustand';
import { readSetting, writeSetting } from './utils';

/**
 * Bookmarked subjects with an optional name, group and note. Kept with the
 * other settings, so with file storage they follow the user to another
 * browser. With thousands of subjects the filter is not a way back to the
 * one you look at every morning.
 */
export interface Bookmark {
  subject: string;
  /** shown instead of the subject when set */
  label?: string;
  /** free grouping, e.g. "Line 3" */
  group?: string;
  note?: string;
  createdAt: number;
}

const KEY = 'ne.bookmarks.v1';

function load(): Bookmark[] {
  const raw = readSetting<unknown>(KEY, []);
  if (!Array.isArray(raw)) return [];
  return (raw as Bookmark[]).filter(b => b && typeof b.subject === 'string');
}

/** The bookmark of a subject, or undefined. */
export function findBookmark(items: Bookmark[], subject: string | null): Bookmark | undefined {
  return subject ? items.find(b => b.subject === subject) : undefined;
}

/** Group names in use, sorted, without the ungrouped bucket. */
export function groupsOf(items: Bookmark[]): string[] {
  const set = new Set<string>();
  for (const b of items) if (b.group?.trim()) set.add(b.group.trim());
  return [...set].sort((a, b) => a.localeCompare(b, 'en'));
}

/** Bookmarks by group, ungrouped last under an empty key, each sorted by label. */
export function byGroup(items: Bookmark[]): [string, Bookmark[]][] {
  const map = new Map<string, Bookmark[]>();
  for (const b of items) {
    const g = b.group?.trim() ?? '';
    const list = map.get(g);
    if (list) list.push(b);
    else map.set(g, [b]);
  }
  const entries = [...map.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'en')));
  for (const [, list] of entries) list.sort((x, y) => (x.label ?? x.subject).localeCompare(y.label ?? y.subject, 'en'));
  return entries;
}

interface BookmarkState {
  items: Bookmark[];
  /** Adds the subject, or removes it when it is already bookmarked. */
  toggle: (subject: string) => void;
  /** Adds or updates one bookmark. */
  save: (bookmark: Bookmark) => void;
  remove: (subject: string) => void;
  /** Re-reads the settings after the backend seeded them. */
  reload: () => void;
}

export const useBookmarks = create<BookmarkState>((set, get) => {
  const persist = (items: Bookmark[]) => {
    writeSetting(KEY, items);
    set({ items });
  };
  return {
    items: load(),
    toggle: subject => {
      const items = get().items;
      persist(items.some(b => b.subject === subject) ? items.filter(b => b.subject !== subject) : [...items, { subject, createdAt: Date.now() }]);
    },
    save: bookmark => {
      const items = get().items;
      persist(items.some(b => b.subject === bookmark.subject) ? items.map(b => (b.subject === bookmark.subject ? bookmark : b)) : [...items, bookmark]);
    },
    remove: subject => persist(get().items.filter(b => b.subject !== subject)),
    reload: () => set({ items: load() }),
  };
});
