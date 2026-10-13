// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdate, isNewer, setUpdateCheckEnabled } from './updateCheck';

const release = (tag: string) =>
  vi.fn(async () => ({
    ok: true,
    json: async () => ({ tag_name: tag, html_url: `https://github.com/blanpa/nats-explorer/releases/tag/${tag}` }),
  })) as unknown as typeof fetch;

beforeEach(() => {
  localStorage.clear();
  setUpdateCheckEnabled(true);
});

describe('isNewer', () => {
  it('reads versions as numbers, not strings', () => {
    expect(isNewer('1.10.0', '1.9.2')).toBe(true);
    expect(isNewer('v0.6.0', '0.5.0')).toBe(true);
    expect(isNewer('0.5.0', '0.5.0')).toBe(false);
    expect(isNewer('0.5.0', '0.5.1')).toBe(false);
    expect(isNewer('0.6', '0.5.9')).toBe(true);
  });
});

describe('checkForUpdate', () => {
  it('names a newer release and keeps quiet about the one running', async () => {
    expect(await checkForUpdate('0.5.0', release('v0.6.0'))).toEqual({ version: '0.6.0', url: 'https://github.com/blanpa/nats-explorer/releases/tag/v0.6.0' });
    localStorage.clear();
    expect(await checkForUpdate('0.6.0', release('v0.6.0'))).toBeNull();
  });

  it('asks once a day', async () => {
    const f = release('v0.6.0');
    await checkForUpdate('0.5.0', f, 1_000_000);
    await checkForUpdate('0.5.0', f, 1_000_000 + 3600_000);
    expect(f).toHaveBeenCalledTimes(1);
    await checkForUpdate('0.5.0', f, 1_000_000 + 25 * 3600_000);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('never asks for a development build, or when switched off, or when the network fails', async () => {
    const f = release('v9.0.0');
    expect(await checkForUpdate('dev', f)).toBeNull();
    setUpdateCheckEnabled(false);
    expect(await checkForUpdate('0.5.0', f)).toBeNull();
    expect(f).not.toHaveBeenCalled();
    setUpdateCheckEnabled(true);
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await checkForUpdate('0.5.0', failing)).toBeNull();
  });
});
