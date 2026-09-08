/** Severity of an alert rule, worst last. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** State of one alert: an expression holds, a subject fell silent, or it is over. */
export type AlertState = 'firing' | 'stale' | 'resolved';

/** One alert definition, kept with the other settings under ne.alerts.v1. */
export interface AlertRule {
  id: string;
  name: string;
  /** NATS subject pattern the rule watches */
  pattern: string;
  /** CEL expression; while it holds for a subject the alert fires */
  expr?: string;
  /** seconds without a message after which the subject counts as silent; 0 disables */
  staleAfter?: number;
  severity: AlertSeverity;
  /** optional URL that receives a JSON POST on every state change */
  webhook?: string;
  enabled: boolean;
}

/** One condition that is currently true: a rule on a subject of a connection. */
export interface Alert {
  key: string;
  ruleId: string;
  ruleName: string;
  connId: string;
  subject: string;
  state: AlertState;
  severity: AlertSeverity;
  /** when the alert started */
  since: number;
  /** the payload that fired it, or the last one before the silence */
  preview?: string;
  /** time of that message */
  at?: number;
}

/** One state change, newest first in the log. */
export interface AlertEvent {
  time: number;
  ruleId: string;
  ruleName: string;
  connId: string;
  subject: string;
  state: AlertState;
  severity: AlertSeverity;
  preview?: string;
  webhookError?: string;
}

/** Answer of POST /api/alerts/rules/{id}/test. */
export interface AlertTestResult {
  /** messages of the pattern that were evaluated */
  sampled: number;
  /** how many of them the expression matched */
  matched: number;
  /** the first few matches, newest first */
  matches: import('./messages.js').NatsMessage[];
  /** set when the pattern could not be sampled from the recorded history */
  note?: string;
}
