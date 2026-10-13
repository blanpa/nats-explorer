import { create } from 'zustand';
import type { Alert, AlertEvent, AlertRule, MaintenanceWindow } from 'shared';
import { alertsApi } from '../lib/api.alerts';
import { errorMessage } from '../lib/api';

/**
 * The alerts that still want attention: not seen yet and not muted. The
 * badge and the toasts count these; the list shows all of them.
 */
export function unattended(active: Alert[]): Alert[] {
  return active.filter(a => !a.ackedAt && !a.muted);
}

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
    // The preview of these says what was measured against what: "3
    // messages in 60 s, fewer than 10". It is the whole story.
    case 'rate':
    case 'level':
    case 'stuck':
      return e.preview ? `${e.subject}: ${e.preview}` : `${e.subject} (${e.ruleName})`;
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
  /** Marks an alert as seen, or takes that back. */
  ack: (key: string, acked?: boolean) => Promise<void>;
  /** Silences a rule until then; null lifts it. */
  mute: (rule: AlertRule, until: number | null) => Promise<void>;
  maintenance: MaintenanceWindow[];
  loadMaintenance: () => Promise<void>;
  saveMaintenance: (windows: MaintenanceWindow[]) => Promise<void>;
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
  ack: async (key, acked = true) => {
    const { active } = await alertsApi.ack(key, acked);
    set({ active: active ?? [] });
  },
  mute: async (rule, until) => {
    const next = { ...rule };
    if (until) next.mutedUntil = until;
    else delete next.mutedUntil;
    await get().save(next);
  },
  maintenance: [],
  loadMaintenance: async () => {
    try {
      const { windows } = await alertsApi.maintenance();
      set({ maintenance: windows ?? [] });
    } catch (err) {
      set({ error: errorMessage(err) });
    }
  },
  saveMaintenance: async windows => {
    const { windows: saved } = await alertsApi.saveMaintenance(windows);
    set({ maintenance: saved ?? [] });
  },
}));
