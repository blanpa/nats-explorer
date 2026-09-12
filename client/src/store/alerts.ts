import { create } from 'zustand';
import type { Alert, AlertEvent, AlertRule } from 'shared';
import { alertsApi } from '../lib/api.alerts';
import { errorMessage } from '../lib/api';

/** The worst severity among a set of alerts, for the rail badge. */
export function worstSeverity(active: Alert[]): 'critical' | 'warning' | 'info' | null {
  let worst: 'critical' | 'warning' | 'info' | null = null;
  for (const a of active) {
    if (a.severity === 'critical') return 'critical';
    if (a.severity === 'warning') worst = 'warning';
    else if (!worst) worst = 'info';
  }
  return worst;
}

/** A one-line description of an event for the log and for toasts. */
export function describeEvent(e: AlertEvent): string {
  switch (e.state) {
    case 'stale':
      return `${e.subject} fell silent`;
    case 'resolved':
      return `${e.subject} is back to normal`;
    default:
      return `${e.subject} matches ${e.ruleName}`;
  }
}

interface AlertsState {
  rules: AlertRule[];
  active: Alert[];
  events: AlertEvent[];
  loading: boolean;
  error: string | null;
  /** Reads rules, active alerts and the log from the backend. */
  load: () => Promise<void>;
  /** Applies a websocket push. */
  apply: (active: Alert[], events?: AlertEvent[]) => void;
  save: (rule: AlertRule) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useAlerts = create<AlertsState>((set, get) => ({
  rules: [],
  active: [],
  events: [],
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true });
    try {
      const [rules, active, events] = await Promise.all([alertsApi.rules(), alertsApi.list(), alertsApi.events()]);
      set({ rules: rules.rules ?? [], active: active.active ?? [], events: events.events ?? [], loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: errorMessage(err) });
    }
  },
  apply: (active, events) => {
    // The log is newest first and bounded; the server sends only the changes.
    const merged = events?.length ? [...events, ...get().events].slice(0, 500) : get().events;
    set({ active, events: merged });
  },
  save: async rule => {
    // The endpoint answers with the single rule, so the list is re-read.
    await alertsApi.save(rule);
    const { rules } = await alertsApi.rules();
    set({ rules: rules ?? [] });
  },
  remove: async id => {
    await alertsApi.remove(id);
    set({ rules: get().rules.filter(r => r.id !== id) });
  },
}));
