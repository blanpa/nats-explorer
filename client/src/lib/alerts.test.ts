import { describe, expect, it } from 'vitest';
import type { Alert, AlertRule } from 'shared';
import { alertRuleForSubject, describeEvent, describeMute, describeRule, newAlertRule, newlyFiring, severityTone, sortAlerts, validateRule } from './alerts';

const rule = (over: Partial<AlertRule> = {}): AlertRule => newAlertRule({ name: 'Hot', pattern: 'plant.>', expr: 'payload.temp > 30', ...over });

const alert = (over: Partial<Alert> = {}): Alert => ({
  key: 'k',
  ruleId: 'r',
  ruleName: 'Hot',
  connId: 'c',
  subject: 'plant.a',
  state: 'firing',
  severity: 'warning',
  since: 1,
  ...over,
});

describe('validateRule', () => {
  it('accepts a rule with an expression or a silence timeout', () => {
    expect(validateRule(rule())).toBeNull();
    expect(validateRule(rule({ expr: '', staleAfter: 30 }))).toBeNull();
  });

  it('names what is missing or wrong', () => {
    expect(validateRule(rule({ name: '  ' }))).toMatch(/name/);
    expect(validateRule(rule({ pattern: '' }))).toMatch(/pattern/);
    expect(validateRule(rule({ pattern: 'a b' }))).toMatch(/spaces/);
    expect(validateRule(rule({ pattern: 'a..b' }))).toMatch(/empty tokens/);
    expect(validateRule(rule({ pattern: 'a.>.b' }))).toMatch(/last token/);
    expect(validateRule(rule({ expr: '', staleAfter: 0 }))).toMatch(/expression/);
    expect(validateRule(rule({ staleAfter: -1 }))).toMatch(/negative/);
    // Learning is a condition of its own: no expression and no timeout needed.
    expect(validateRule(rule({ expr: '', staleAuto: true }))).toBeNull();
    expect(validateRule(rule({ webhook: 'example.com' }))).toMatch(/http/);
    expect(validateRule(rule({ webhook: 'https://example.com/hook' }))).toBeNull();
  });
});

describe('rule and alert helpers', () => {
  it('describes what a rule watches', () => {
    expect(describeRule(rule())).toBe('payload.temp > 30');
    expect(describeRule(rule({ staleAfter: 60 }))).toBe('payload.temp > 30 or silent for 60s');
    expect(describeRule(rule({ expr: '', staleAfter: 60 }))).toBe('silent for 60s');
    // A rule that learns says what it learned to expect.
    expect(describeRule(rule({ expr: '', staleAuto: true }))).toBe('silent for ten times its usual gap');
    expect(describeRule(rule({ expr: '', staleAuto: true, staleAfter: 60 }))).toContain('at least 60s');
  });

  it('sorts the worst and newest alerts first', () => {
    const sorted = sortAlerts([
      alert({ key: 'a', severity: 'info', since: 3 }),
      alert({ key: 'b', severity: 'critical', since: 1 }),
      alert({ key: 'c', severity: 'critical', since: 2 }),
    ]);
    expect(sorted.map(a => a.key)).toEqual(['c', 'b', 'a']);
  });

  it('reports only alerts that were not there before', () => {
    const before = [alert({ key: 'a' })];
    const after = [alert({ key: 'a' }), alert({ key: 'b' })];
    expect(newlyFiring(before, after).map(a => a.key)).toEqual(['b']);
    expect(newlyFiring(after, after)).toEqual([]);
  });

  it('maps severity to a badge tone and events to a line', () => {
    expect(severityTone('critical')).toBe('danger');
    expect(severityTone('info')).toBe('info');
    expect(describeEvent({ time: 1, ruleId: 'r', ruleName: 'Hot', connId: 'c', subject: 's', state: 'firing', severity: 'warning' })).toBe('Hot fired');
    expect(describeEvent({ time: 1, ruleId: 'r', ruleName: 'Hot', connId: 'c', subject: 's', state: 'stale', severity: 'warning' })).toMatch(/no messages/);
    expect(describeEvent({ time: 1, ruleId: 'r', ruleName: 'Hot', connId: 'c', subject: 's', state: 'resolved', severity: 'warning' })).toMatch(/resolved/);
  });
});

describe('alertRuleForSubject', () => {
  it('takes the subject as the pattern, and as a name to start from', () => {
    const r = alertRuleForSubject('uns.acme.factory-berlin.assembly.line-1.robot-02.position');
    expect(r.pattern).toBe('uns.acme.factory-berlin.assembly.line-1.robot-02.position');
    expect(r.name).toBe(r.pattern);
    // Nothing else is decided for the reader: no expression yet, so the
    // dialog opens on the question it needs answered.
    expect(r.expr).toBeUndefined();
    expect(r.enabled).toBe(true);
  });

  it('covers everything under a branch', () => {
    expect(alertRuleForSubject('uns.acme.factory-berlin', true).pattern).toBe('uns.acme.factory-berlin.>');
  });

  it('leaves the condition, and nothing else, to be filled in', () => {
    // Everything the subject can decide is decided; what is missing is the
    // one thing only the reader knows.
    const r = alertRuleForSubject('plant.line1.temp');
    expect(validateRule(r)).toMatch(/^A rule needs a condition/);
    expect(validateRule({ ...r, expr: 'payload.temp > 80' })).toBeNull();
  });
});

describe('window, stuck and channel rules', () => {
  const base = { id: 'r', name: 'quiet', pattern: 'plant.>', severity: 'warning' as const, enabled: true };

  it('describes the conditions a window adds', () => {
    expect(describeRule({ ...base, window: 60, minCount: 10 })).toBe('fewer than 10 messages in 60 s');
    expect(describeRule({ ...base, window: 300, maxCount: 1000 })).toBe('more than 1000 messages in 5 min');
    expect(describeRule({ ...base, window: 3600, field: 'temp', above: 80 })).toBe('avg temp over 1 h above 80');
    expect(describeRule({ ...base, window: 60, field: 'temp', agg: 'min', below: 0 })).toBe('min temp over 60 s below 0');
    expect(describeRule({ ...base, unchangedFor: 600, field: 'temp' })).toBe('temp unchanged for 10 min');
    expect(describeRule({ ...base, unchangedFor: 30 })).toBe('payload unchanged for 30 s');
    expect(describeRule({ ...base, expr: 'true', window: 60, minCount: 1 })).toBe('true or fewer than 1 messages in 60 s');
  });

  it('accepts a window condition as the only condition, and names what is missing', () => {
    expect(validateRule({ ...base, window: 60, minCount: 10 })).toBeNull();
    expect(validateRule({ ...base, unchangedFor: 10 })).toBeNull();
    expect(validateRule({ ...base, window: 60 })).toMatch(/needs a condition/);
    expect(validateRule({ ...base, minCount: 10 })).toMatch(/needs a window/);
    expect(validateRule({ ...base, window: 60, above: 1 })).toMatch(/needs a field/);
    expect(validateRule({ ...base, window: 100_000, minCount: 1 })).toMatch(/24 h/);
    expect(validateRule({ ...base, window: 60, minCount: -1 })).toMatch(/negative/);
    expect(validateRule({ ...base, expr: 'true', email: 'nobody' })).toMatch(/email address/);
    expect(validateRule({ ...base, expr: 'true', email: 'a@x.io, b@x.io' })).toBeNull();
  });

  it('says how long a mute lasts', () => {
    const now = 1_000_000;
    expect(describeMute({ ...base, mutedUntil: now + 14 * 60_000 + 1 }, now)).toBe('muted for 15 min');
    expect(describeMute({ ...base, mutedUntil: now + 3 * 3600_000 }, now)).toBe('muted for 3 h');
    expect(describeMute({ ...base, mutedUntil: now - 1 }, now)).toBe('');
    expect(describeMute(base, now)).toBe('');
  });

  it('tells a window event by its preview', () => {
    const ev = { time: 1, ruleId: 'r', ruleName: 'Quiet', connId: 'c', subject: 's', severity: 'warning' as const };
    expect(describeEvent({ ...ev, state: 'rate', preview: '3 messages in 60 s, fewer than 10' })).toBe('Quiet: 3 messages in 60 s, fewer than 10');
    expect(describeEvent({ ...ev, state: 'stuck', preview: 'temp = 21.5 unchanged for 12 min' })).toMatch(/unchanged/);
  });
});
