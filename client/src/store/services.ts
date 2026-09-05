import { create } from 'zustand';
import type { ServiceInfo, ServiceStats } from 'shared';
import { api, errorMessage } from '../lib/api';

interface ServicesState {
  connId: string | null;
  services: ServiceInfo[];
  stats: ServiceStats[];
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  refresh: (connId: string) => Promise<void>;
}

/** Shared between the service list (explorer) and the detail pane. */
export const useServices = create<ServicesState>((set, get) => ({
  connId: null,
  services: [],
  stats: [],
  loading: false,
  error: null,
  loadedAt: null,
  refresh: async connId => {
    if (get().loading && get().connId === connId) return;
    set({ loading: true, connId, ...(get().connId !== connId ? { services: [], stats: [], error: null } : {}) });
    const [info, stats] = await Promise.allSettled([api.discoverServices(connId), api.getServiceStats(connId)]);
    if (get().connId !== connId) return;
    if (info.status === 'rejected') {
      set({ loading: false, error: errorMessage(info.reason) });
      return;
    }
    set({
      loading: false,
      error: null,
      services: info.value,
      stats: stats.status === 'fulfilled' ? stats.value : [],
      loadedAt: Date.now(),
    });
  },
}));
