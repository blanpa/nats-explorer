import { describe, expect, it } from 'vitest';
import type { Alert, AlertRule } from 'shared';
import { describeEvent, describeRule, newAlertRule, newlyFiring, severityTone, sortAlerts, validateRule } from './alerts';

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
    expect(validateRule(rule({ webhook: 'example.com' }))).toMatch(/http/);
    expect(validateRule(rule({ webhook: 'https://example.com/hook' }))).toBeNull();
  });
});

describe('rule and alert helpers', () => {
  it('describes what a rule watches', () => {
    expect(describeRule(rule())).toBe('payload.temp > 30');
    expect(describeRule(rule({ staleAfter: 60 }))).toBe('payload.temp > 30 or silent for 60s');
    expect(describeRule(rule({ expr: '', staleAfter: 60 }))).toBe('silent for 60s');
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
