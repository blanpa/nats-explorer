import type { Alert, AlertEvent, AlertRule, AlertTestResult, MaintenanceWindow } from 'shared';
import { request } from './api';
import { uuid } from './utils';

/** The alert rules and what they currently report. */
export const alertsApi = {
  list: () => request<{ active: Alert[] }>('/alerts'),
  rules: () => request<{ rules: AlertRule[] }>('/alerts/rules'),
  events: (limit = 200) => request<{ events: AlertEvent[] }>(`/alerts/events?limit=${limit}`),
  /** Replaces the whole set, which is how the UI saves. */
  saveAll: (rules: AlertRule[]) => request<{ rules: AlertRule[] }>('/alerts/rules', { method: 'PUT', body: JSON.stringify(rules) }),
  save: (rule: AlertRule) => request<AlertRule>(`/alerts/rules/${encodeURIComponent(rule.id)}`, { method: 'PUT', body: JSON.stringify(rule) }),
  remove: (id: string) => request<void>(`/alerts/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Runs a rule against the recorded messages before it is saved. */
  test: (rule: AlertRule) => request<AlertTestResult>(`/alerts/rules/${encodeURIComponent(rule.id)}/test`, { method: 'POST', body: JSON.stringify(rule) }),
  /** Marks an alert as seen, or takes that back; the key goes in the body because it holds the subject. */
  ack: (key: string, acked = true) => request<{ active: Alert[] }>('/alerts/ack', { method: 'POST', body: JSON.stringify({ key, acked }) }),
  maintenance: () => request<{ windows: MaintenanceWindow[] }>('/alerts/maintenance'),
  /** Replaces the whole list, as the rules are. */
  saveMaintenance: (windows: MaintenanceWindow[]) =>
    request<{ windows: MaintenanceWindow[] }>('/alerts/maintenance', { method: 'PUT', body: JSON.stringify(windows) }),
};

export function newAlertRule(partial: Partial<AlertRule> = {}): AlertRule {
  return { id: uuid(), name: '', pattern: '', severity: 'warning', enabled: true, ...partial };
}
