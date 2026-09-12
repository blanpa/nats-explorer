import { create } from 'zustand';
import { loadSavedRequests, persistSavedRequests, type SavedRequest } from '../lib/savedRequests';

interface SavedRequestsState {
  items: SavedRequest[];
  upsert: (item: SavedRequest) => void;
  remove: (id: string) => void;
  /** merge imported items; same id wins over the existing entry */
  importMany: (items: SavedRequest[]) => number;
}

export const useSavedRequests = create<SavedRequestsState>((set, get) => ({
  items: loadSavedRequests(),
  upsert: item => {
    const exists = get().items.some(i => i.id === item.id);
    const items = exists ? get().items.map(i => (i.id === item.id ? item : i)) : [...get().items, item];
    persistSavedRequests(items);
    set({ items });
  },
  remove: id => {
    const items = get().items.filter(i => i.id !== id);
    persistSavedRequests(items);
    set({ items });
  },
  importMany: incoming => {
    const byId = new Map(get().items.map(i => [i.id, i]));
    for (const it of incoming) byId.set(it.id, it);
    const items = [...byId.values()];
    persistSavedRequests(items);
    set({ items });
    return incoming.length;
  },
}));
