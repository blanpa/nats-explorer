// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bundleUrl } from './api.bundle';

describe('bundleUrl', () => {
  it('carries only what was asked for', () => {
    expect(bundleUrl({ connId: 'c1' })).toBe('/api/bundle?connId=c1');
    const url = new URL(bundleUrl({ connId: 'c1', from: 100, to: 200, subject: ' plant.line1 ', limit: 500 }), 'http://x');
    expect(Object.fromEntries(url.searchParams)).toEqual({ connId: 'c1', from: '100', to: '200', subject: 'plant.line1', limit: '500' });
  });

  it('leaves out an empty subject and a zero range', () => {
    const url = new URL(bundleUrl({ connId: 'c1', from: 0, subject: '   ' }), 'http://x');
    expect(url.searchParams.has('subject')).toBe(false);
    expect(url.searchParams.has('from')).toBe(false);
  });

  it('escapes what belongs in a query string', () => {
    const url = new URL(bundleUrl({ connId: 'a b&c', subject: 'x.>' }), 'http://x');
    expect(url.searchParams.get('connId')).toBe('a b&c');
    expect(url.searchParams.get('subject')).toBe('x.>');
  });
});
