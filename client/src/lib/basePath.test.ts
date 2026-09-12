// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { basePath, serverUrl, socketUrl } from './basePath';

/** Sets the document's base href, the way the server writes it into index.html. */
function setBase(href: string) {
  document.querySelector('base')?.remove();
  const base = document.createElement('base');
  base.href = href;
  document.head.prepend(base);
}

afterEach(() => document.querySelector('base')?.remove());

describe('base path', () => {
  it('takes the prefix from the base href', () => {
    setBase('http://host/nats/');
    expect(basePath()).toBe('/nats/');
    expect(serverUrl('/api/app')).toBe('/nats/api/app');
    expect(serverUrl('api/app')).toBe('/nats/api/app');
  });

  it('serves from the root without one', () => {
    setBase('http://host/');
    expect(basePath()).toBe('/');
    expect(serverUrl('/api/app')).toBe('/api/app');
  });

  it('builds the websocket endpoint under the prefix', () => {
    setBase('http://host/nats/');
    // jsdom serves the page over http, so the scheme is ws.
    expect(socketUrl()).toBe(`ws://${window.location.host}/nats/ws`);
  });

  it('is read per call, not captured once', () => {
    setBase('http://host/one/');
    expect(serverUrl('/ws')).toBe('/one/ws');
    // A value frozen at module load would still say /one here -- and a
    // bundler that folds it away would say /ws for every deployment.
    setBase('http://host/two/');
    expect(serverUrl('/ws')).toBe('/two/ws');
  });
});
