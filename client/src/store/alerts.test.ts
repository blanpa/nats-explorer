// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Alert, AlertEvent } from 'shared';
import { describeEvent, unattended, worstSeverity } from './alerts';

const alert = (severity: Alert['severity']): Alert => ({
  key: `k${severity}`,
  ruleId: 'r',
  ruleName: 'Rule',
  connId: 'c',
  subject: 's',
  state: 'firing',
  severity,
  since: 1,
});

const event = (state: AlertEvent['state']): AlertEvent => ({
  time: 1,
  ruleId: 'r',
  ruleName: 'Too hot',
  connId: 'c',
  subject: 'plant.line1.temp',
  state,
  severity: 'warning',
});

describe('worstSeverity', () => {
  it('reports the worst severity present', () => {
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity([alert('info')])).toBe('info');
    expect(worstSeverity([alert('info'), alert('warning')])).toBe('warning');
    expect(worstSeverity([alert('warning'), alert('critical'), alert('info')])).toBe('critical');
  });
});

describe('describeEvent', () => {
  it('says what happened in one line', () => {
    expect(describeEvent(event('firing'))).toBe('plant.line1.temp matches Too hot');
    expect(describeEvent(event('stale'))).toBe('plant.line1.temp fell silent');
    expect(describeEvent(event('resolved'))).toBe('plant.line1.temp is back to normal');
  });
});

describe('unattended', () => {
  it('leaves out what was seen and what is muted', () => {
    const a = (key: string, over: Partial<Alert> = {}): Alert => ({
      key,
      ruleId: 'r',
      ruleName: 'r',
      connId: 'c',
      subject: key,
      state: 'firing',
      severity: 'warning',
      since: 1,
      ...over,
    });
    const list = [a('new'), a('seen', { ackedAt: 5, ackedBy: 'pascal' }), a('quiet', { muted: true })];
    expect(unattended(list).map(x => x.key)).toEqual(['new']);
  });

  it('describes a window event by what was measured', () => {
    expect(describeEvent({ ...event('rate'), preview: '3 messages in 60 s, fewer than 10' })).toBe('plant.line1.temp: 3 messages in 60 s, fewer than 10');
    expect(describeEvent({ ...event('level'), preview: undefined })).toBe('plant.line1.temp (Too hot)');
  });
});
