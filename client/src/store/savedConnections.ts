import { create } from 'zustand';
import { api, errorMessage } from '../lib/api';
import { loadSavedConnections, persistSavedConnections, toConnectionConfig, type SavedConnection } from '../lib/savedConnections';
import { toast } from '../components/ui/Toast';
import { useStore } from './index';

interface SavedConnectionsState {
  items: SavedConnection[];
  connecting: Set<string>;
  upsert: (item: SavedConnection) => void;
  remove: (id: string) => void;
  connect: (id: string) => Promise<boolean>;
  disconnect: (id: string) => Promise<void>;
}

export const useSavedConnections = create<SavedConnectionsState>((set, get) => ({
  items: loadSavedConnections(),
  connecting: new Set(),

  upsert: item => {
    const items = get().items.some(i => i.id === item.id) ? get().items.map(i => (i.id === item.id ? item : i)) : [...get().items, item];
    persistSavedConnections(items);
    set({ items });
  },

  remove: id => {
    const items = get().items.filter(i => i.id !== id);
    persistSavedConnections(items);
    set({ items });
  },

  connect: async id => {
    const saved = get().items.find(i => i.id === id);
    if (!saved) return false;
    set(s => ({ connecting: new Set(s.connecting).add(id) }));
    try {
      const res = await api.connect(toConnectionConfig(saved));
      useStore.getState().setActiveConnId(res.id);
      toast.success(`Connected to ${saved.name || saved.servers[0]}`);
      return true;
    } catch (err) {
      toast.error(`Could not connect to ${saved.name || saved.servers[0]}`, errorMessage(err));
      return false;
    } finally {
      set(s => {
        const next = new Set(s.connecting);
        next.delete(id);
        return { connecting: next };
      });
    }
  },

  disconnect: async id => {
    try {
      await api.disconnect(id);
    } catch (err) {
      toast.error('Disconnect failed', errorMessage(err));
    }
  },
}));
