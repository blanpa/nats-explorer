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
  const window = rule.window ?? 0;
  const counts = rule.minCount != null || rule.maxCount != null;
  const threshold = rule.above != null || rule.below != null;
  // A half-written window condition is named before the general complaint:
  // a count without a window is a rule that is almost there.
  if ((counts || threshold) && window <= 0) return 'A count or a threshold over time needs a window.';
  if (
    !rule.expr?.trim() &&
    !(rule.staleAfter && rule.staleAfter > 0) &&
    !rule.staleAuto &&
    !(window > 0 && (counts || threshold)) &&
    !(rule.unchangedFor && rule.unchangedFor > 0)
  )
    return 'A rule needs a condition: an expression, a silence, a count or a threshold over a window, or an unchanged value.';
  if ((rule.staleAfter ?? 0) < 0) return 'The silence timeout cannot be negative.';
  if (window < 0 || window > 24 * 3600) return 'The window must be between 1 s and 24 h.';
  if ((rule.minCount ?? 0) < 0 || (rule.maxCount ?? 0) < 0) return 'A message count cannot be negative.';
  if (threshold && !rule.field?.trim()) return 'A threshold over time needs a field.';
  if ((rule.unchangedFor ?? 0) < 0) return 'The unchanged time cannot be negative.';
  if (rule.webhook?.trim() && !/^https?:\/\//.test(rule.webhook.trim())) return 'The webhook must be an http:// or https:// URL.';
  if (rule.email?.trim() && rule.email.split(/[,; ]+/).some(a => a && !a.includes('@'))) return 'Every recipient needs an email address.';
  return null;
}

/** A window in words: "60 s", "5 min", "2 h". */
export function describeWindow(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds >= 120 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** Rule text for the table: what the rule watches, in one phrase. */
export function describeRule(rule: AlertRule): string {
  const parts: string[] = [];
  if (rule.expr?.trim()) parts.push(rule.expr.trim());
  if (rule.staleAuto) parts.push(rule.staleAfter ? `silent for ten times its usual gap, at least ${rule.staleAfter}s` : 'silent for ten times its usual gap');
  else if (rule.staleAfter && rule.staleAfter > 0) parts.push(`silent for ${rule.staleAfter}s`);
  const window = rule.window ?? 0;
  if (window > 0) {
    const w = describeWindow(window);
    if (rule.minCount != null) parts.push(`fewer than ${rule.minCount} messages in ${w}`);
    if (rule.maxCount != null) parts.push(`more than ${rule.maxCount} messages in ${w}`);
    if (rule.field && (rule.above != null || rule.below != null)) {
      const agg = `${rule.agg ?? 'avg'} ${rule.field} over ${w}`;
      if (rule.above != null) parts.push(`${agg} above ${rule.above}`);
      if (rule.below != null) parts.push(`${agg} below ${rule.below}`);
    }
  }
  if (rule.unchangedFor && rule.unchangedFor > 0) parts.push(`${rule.field || 'payload'} unchanged for ${describeWindow(rule.unchangedFor)}`);
  return parts.join(' or ');
}

/** How long a mute still lasts, in words; empty when it is over. */
export function describeMute(rule: AlertRule, now = Date.now()): string {
  const left = (rule.mutedUntil ?? 0) - now;
  if (left <= 0) return '';
  const min = Math.ceil(left / 60_000);
  if (min < 60) return `muted for ${min} min`;
  if (min < 24 * 60) return `muted for ${Math.round(min / 60)} h`;
  return `muted until ${new Date(rule.mutedUntil as number).toLocaleString()}`;
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
    case 'rate':
    case 'level':
    case 'stuck':
      return `${event.ruleName}: ${event.preview ?? event.state}`;
    default:
      return `${event.ruleName} resolved`;
  }
}
