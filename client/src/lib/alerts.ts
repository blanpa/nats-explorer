import type { Alert, AlertEvent, AlertRule, AlertSeverity } from 'shared';
import type { BadgeTone } from '../components/ui/misc';
import { uuid } from './utils';

/** Severities worst last, for sorting and for the dropdown. */
export const SEVERITIES: AlertSeverity[] = ['info', 'warning', 'critical'];

const SEVERITY_TONE: Record<AlertSeverity, BadgeTone> = { info: 'info', warning: 'warn', critical: 'danger' };

/** Badge tone of a severity; a resolved alert is neutral whatever its rule says. */
export function severityTone(severity: AlertSeverity): BadgeTone {
  return SEVERITY_TONE[severity] ?? 'neutral';
}

export function newAlertRule(partial: Partial<AlertRule> = {}): AlertRule {
  return { id: uuid(), name: '', pattern: '', severity: 'warning', enabled: true, ...partial };
}

/**
 * A rule for the subject on screen: the subject itself, or everything under
 * it when a branch is selected. Written from the Alerts module the pattern
 * has to be typed out, and a subject like
 * `uns.acme.factory-berlin.assembly.line-1` is where a token gets lost.
 */
export function alertRuleForSubject(subject: string, branch = false): AlertRule {
  const pattern = branch ? `${subject}.>` : subject;
  return newAlertRule({ pattern, name: pattern });
}

/**
 * Checks a rule the way the backend does, so the dialog can say what is
 * wrong before the request goes out. Returns null when the rule is good.
 */
export function validateRule(rule: AlertRule): string | null {
  if (!rule.name.trim()) return 'A rule needs a name.';
  const pattern = rule.pattern.trim();
  if (!pattern) return 'A rule needs a subject pattern.';
  if (/\s/.test(pattern)) return 'A subject pattern cannot contain spaces.';
  const tokens = pattern.split('.');
  if (tokens.some(t => t === '')) return 'A subject pattern cannot have empty tokens.';
  if (tokens.some((t, i) => t === '>' && i !== tokens.length - 1)) return 'The > wildcard is only allowed as the last token.';
  if (!rule.expr?.trim() && !(rule.staleAfter && rule.staleAfter > 0)) return 'A rule needs an expression, a silence timeout, or both.';
  if ((rule.staleAfter ?? 0) < 0) return 'The silence timeout cannot be negative.';
  if (rule.webhook?.trim() && !/^https?:\/\//.test(rule.webhook.trim())) return 'The webhook must be an http:// or https:// URL.';
  return null;
}

/** Rule text for the table: what the rule watches, in one phrase. */
export function describeRule(rule: AlertRule): string {
  const parts: string[] = [];
  if (rule.expr?.trim()) parts.push(rule.expr.trim());
  if (rule.staleAfter && rule.staleAfter > 0) parts.push(`silent for ${rule.staleAfter}s`);
  return parts.join(' or ');
}

/** Alerts worst first, then newest first, so the list leads with what matters. */
export function sortAlerts(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || b.since - a.since);
}

/** Alerts that just appeared, so only those raise a toast. */
export function newlyFiring(previous: Alert[], next: Alert[]): Alert[] {
  const known = new Set(previous.map(a => a.key));
  return next.filter(a => !known.has(a.key));
}

/** One log line: who changed and into what. */
export function describeEvent(event: AlertEvent): string {
  switch (event.state) {
    case 'firing':
      return `${event.ruleName} fired`;
    case 'stale':
      return `${event.ruleName}: no messages`;
    default:
      return `${event.ruleName} resolved`;
  }
}
