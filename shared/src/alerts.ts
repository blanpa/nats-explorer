/** Severity of an alert rule, worst last. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/**
 * State of one alert: an expression holds, a subject fell silent, too few
 * or too many messages in the window, an aggregate out of range, a value
 * that has not changed, or it is over.
 */
export type AlertState = 'firing' | 'stale' | 'rate' | 'level' | 'stuck' | 'resolved';

/** Shape of the webhook POST: plain JSON, or what Slack or Teams expect. */
export type WebhookFormat = 'json' | 'slack' | 'teams';

/** Reduction of a field over the window. */
export type AlertAgg = 'avg' | 'min' | 'max';

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
  /**
   * Learns each subject's own rhythm instead of being told a timeout: a
   * subject is reported after ten times its usual gap between messages.
   * `staleAfter` is then a floor rather than the threshold.
   */
  staleAuto?: boolean;
  severity: AlertSeverity;
  /** optional URL that receives a POST on every state change */
  webhook?: string;
  /** shape of that POST; json when absent */
  webhookFormat?: WebhookFormat;
  /** recipients, comma separated; the server needs SMTP_HOST for them */
  email?: string;
  enabled: boolean;
  /** seconds the window conditions count over; 0 or absent means none */
  window?: number;
  /** fires when fewer messages than this arrived in the window */
  minCount?: number;
  /** fires when more messages than this arrived in the window */
  maxCount?: number;
  /** dotted path into the payload for the aggregate and the unchanged check */
  field?: string;
  /** how the field is reduced over the window; avg when absent */
  agg?: AlertAgg;
  /** the aggregate above this fires */
  above?: number;
  /** the aggregate below this fires */
  below?: number;
  /** seconds the field, or the payload, may be reported again without changing */
  unchangedFor?: number;
  /** unix ms; until then changes are logged but not sent, and not toasted */
  mutedUntil?: number;
}

/** A planned window in which alerts are logged but not sent. */
export interface MaintenanceWindow {
  id: string;
  name: string;
  from: number;
  to: number;
  /** subject patterns it covers; none means every subject */
  patterns?: string[];
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
  /** the rule or a maintenance window keeps it out of the channels */
  muted?: boolean;
  /** someone has seen it; it stays until it resolves but no longer counts as new */
  ackedAt?: number;
  ackedBy?: string;
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
  /** what went wrong sending it, webhook or email */
  webhookError?: string;
  /** logged, but not sent */
  muted?: boolean;
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
