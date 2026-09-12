import { describe, expect, it } from 'vitest';
import { collectLocal, seedLocal, type StorageLike } from './storage';

function memStorage(init: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    get length() {
      return data.size;
    },
    key: i => [...data.keys()][i] ?? null,
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('storage helpers', () => {
  it('collects only JSON ne.* entries', () => {
    const s = memStorage({ 'ne.theme': '"dark"', 'ne.connections.v2': '[{"id":"a"}]', 'ne.legacy': 'dark', other: '1' });
    expect(collectLocal(s)).toEqual({ 'ne.theme': 'dark', 'ne.connections.v2': [{ id: 'a' }] });
  });

  it('seeds local storage from backend entries and ignores foreign keys', () => {
    const s = memStorage();
    const n = seedLocal(s, { 'ne.theme': 'light', 'ne.requests.v1': [{ id: 'r' }], evil: 1 });
    expect(n).toBe(2);
    expect(s.getItem('ne.theme')).toBe('"light"');
    expect(JSON.parse(s.getItem('ne.requests.v1')!)).toEqual([{ id: 'r' }]);
    expect(s.getItem('evil')).toBeNull();
  });
});
