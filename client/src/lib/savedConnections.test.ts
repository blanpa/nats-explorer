import { describe, expect, it } from 'vitest';
import { migrateLegacy, newSavedConnection, toConnectionConfig } from './savedConnections';

describe('savedConnections', () => {
  it('migrates the legacy host/port format and keeps credentials', () => {
    const [m] = migrateLegacy([
      { name: 'Old', host: 'nats.local', port: '4333', authMethod: 'token', token: 't', subscriptions: [], sysTopics: { sys: true } },
    ]);
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
      jsDomain: ' leaf-a ',
    });
    const cfg = toConnectionConfig(saved);
    expect(cfg.id).toBe('abc');
    expect(cfg.name).toBe('nats://a:4222');
    expect(cfg.subscriptions).toEqual(['orders.>', '$JS.>']);
    expect(cfg.user).toBe('u');
    expect(cfg.token).toBeUndefined();
    expect(cfg.jsDomain).toBe('leaf-a');
    expect(cfg.jsApiPrefix).toBeUndefined();
  });

  it('sends system-account credentials only for the chosen method', () => {
    const base = {
      servers: ['nats://a:4222'],
      authMethod: 'none' as const,
      subscriptions: ['>'],
      sysTopics: {},
      sysUser: 'sys',
      sysPass: 'pw',
      sysToken: 'tok',
    };
    expect(toConnectionConfig(newSavedConnection({ ...base })).sysAuthMethod).toBeUndefined();
    const cfg = toConnectionConfig(newSavedConnection({ ...base, sysAuthMethod: 'userpass' }));
    expect(cfg).toMatchObject({ sysAuthMethod: 'userpass', sysUser: 'sys', sysPass: 'pw' });
    expect(cfg.sysToken).toBeUndefined();
  });

  it('sends TLS material only when TLS is on', () => {
    const base = {
      servers: ['tls://a:4222'],
      authMethod: 'none' as const,
      subscriptions: ['>'],
      sysTopics: {},
      tlsCa: 'CA',
      tlsCert: 'CERT',
      tlsKey: 'KEY',
      tlsInsecure: true,
    };
    expect(toConnectionConfig(newSavedConnection({ ...base, tls: false })).tlsCa).toBeUndefined();
    const on = toConnectionConfig(newSavedConnection({ ...base, tls: true }));
    expect(on).toMatchObject({ tls: true, tlsCa: 'CA', tlsCert: 'CERT', tlsKey: 'KEY', tlsInsecure: true });
  });

  it('does not duplicate a system subject the user already listed', () => {
    const cfg = toConnectionConfig(newSavedConnection({ subscriptions: ['$SYS.>'], sysTopics: { sys: true } }));
    expect(cfg.subscriptions).toEqual(['$SYS.>']);
  });
});
