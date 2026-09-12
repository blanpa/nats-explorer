// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Alert, AlertEvent } from 'shared';
import { describeEvent, worstSeverity } from './alerts';

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
