import { describe, expect, it } from 'vitest';
import { migrateLegacy, newSavedConnection, toConnectionConfig } from './savedConnections';

describe('savedConnections', () => {
  it('migrates the legacy host/port format and keeps credentials', () => {
    const [m] = migrateLegacy([{ name: 'Old', host: 'nats.local', port: '4333', authMethod: 'token', token: 't', subscriptions: [], sysTopics: { sys: true } }]);
    expect(m.id).toMatch(/[0-9a-f-]{36}/);
    expect(m.servers).toEqual(['nats://nats.local:4333']);
    expect(m.subscriptions).toEqual(['>']);
    expect(m.token).toBe('t');
    expect(m.sysTopics.sys).toBe(true);
  });

  it('builds the connect payload with system subjects and only the matching credentials', () => {
    const saved = newSavedConnection({
      id: 'abc',
      name: '',
      servers: ['nats://a:4222'],
      authMethod: 'userpass',
      user: 'u',
      pass: 'p',
      token: 'should-not-be-sent',
      subscriptions: ['orders.>'],
      sysTopics: { js: true, kv: false },
    });
    const cfg = toConnectionConfig(saved);
    expect(cfg.id).toBe('abc');
    expect(cfg.name).toBe('nats://a:4222');
    expect(cfg.subscriptions).toEqual(['orders.>', '$JS.>']);
    expect(cfg.user).toBe('u');
    expect(cfg.token).toBeUndefined();
  });

  it('does not duplicate a system subject the user already listed', () => {
    const cfg = toConnectionConfig(newSavedConnection({ subscriptions: ['$SYS.>'], sysTopics: { sys: true } }));
    expect(cfg.subscriptions).toEqual(['$SYS.>']);
  });
});
