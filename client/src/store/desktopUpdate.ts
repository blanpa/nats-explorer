import { create } from 'zustand';
import { api, errorMessage } from '../lib/api';
import type { UpdateStatus } from '../lib/updateCheck';

/**
 * The desktop app's own update as the backend reports it, one copy for the
 * status bar and the settings: an update installed from files or taken back
 * in the settings shows in the status bar at once, and a download started
 * in the status bar shows in the settings. The state is always the
 * backend's; a refused action keeps its message apart and asks again, so a
 * refused second update does not hide the one waiting for its restart.
 */
interface DesktopUpdateState {
  status: UpdateStatus | null;
  /** why the last action was refused; empty once one goes through */
  error: string;
  restarting: boolean;
  /** Asks the backend; a failed request keeps what is known. */
  refresh: () => Promise<void>;
  /** Runs an update call and keeps its answer. */
  run: (call: () => Promise<UpdateStatus>) => Promise<void>;
  restart: () => Promise<void>;
}

export const useDesktopUpdate = create<DesktopUpdateState>((set, get) => ({
  status: null,
  error: '',
  restarting: false,

  refresh: async () => {
    try {
      set({ status: await api.getUpdate() });
    } catch {
      /* the next look asks again */
    }
  },

  run: async call => {
    set({ error: '' });
    try {
      set({ status: await call() });
    } catch (e) {
      set({ error: errorMessage(e) });
      await get().refresh();
    }
  },

  restart: async () => {
    set({ restarting: true, error: '' });
    try {
      await api.restartForUpdate();
    } catch (e) {
      set({ restarting: false, error: errorMessage(e) });
    }
  },
}));
