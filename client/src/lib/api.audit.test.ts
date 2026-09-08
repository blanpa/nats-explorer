// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { type AuditEntry, objectOf, statusTone } from './api.audit';

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  time: 1,
  user: 'alice',
  role: 'admin',
  ip: '10.0.0.1',
  method: 'POST',
  path: '/api/publish',
  status: 200,
  summary: '',
  ...over,
});

describe('objectOf', () => {
  it('names what the write acted on', () => {
    expect(objectOf(entry({ path: '/api/publish' }))).toBe('publish');
    expect(objectOf(entry({ path: '/api/streams/ORDERS/consumers/worker' }))).toBe('streams');
    expect(objectOf(entry({ path: '/api/kv/config/mode' }))).toBe('kv');
  });
});

describe('statusTone', () => {
  it('separates success, refusal and failure', () => {
    expect(statusTone(200)).toBe('ok');
    expect(statusTone(204)).toBe('ok');
    expect(statusTone(403)).toBe('warn');
    expect(statusTone(404)).toBe('warn');
    expect(statusTone(500)).toBe('danger');
  });
});
