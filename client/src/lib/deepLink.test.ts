import { describe, expect, it } from 'vitest';
import { formatLink, linkFromState, linkTarget, parseLink } from './deepLink';

describe('parseLink', () => {
  it('reads the module and the selection', () => {
    expect(parseLink('#/jetstream?conn=abc&stream=ORDERS')).toEqual({ module: 'jetstream', conn: 'abc', stream: 'ORDERS' });
  });

  it('keeps a subject with dots, wildcards and spaces', () => {
    const link = parseLink(formatLink({ module: 'subjects', subject: 'plant.line 1.*.temp' }));
    expect(link.subject).toBe('plant.line 1.*.temp');
  });

  it('takes a window only with both ends in order', () => {
    expect(parseLink('#/subjects?subject=a&from=100&to=200')).toMatchObject({ from: 100, to: 200 });
    expect(parseLink('#/subjects?subject=a&from=100')).not.toHaveProperty('from');
    expect(parseLink('#/subjects?subject=a&from=200&to=100')).not.toHaveProperty('from');
    expect(parseLink('#/subjects?subject=a&from=x&to=y')).not.toHaveProperty('to');
  });

  it('ignores a module it does not know and an empty hash', () => {
    expect(parseLink('#/nowhere?conn=abc')).toEqual({ conn: 'abc' });
    expect(parseLink('')).toEqual({});
    expect(parseLink('#')).toEqual({});
  });

  it('accepts the hash with or without the slash', () => {
    expect(parseLink('#kv?bucket=cfg')).toEqual({ module: 'kv', bucket: 'cfg' });
    expect(parseLink('/kv?bucket=cfg')).toEqual({ module: 'kv', bucket: 'cfg' });
  });
});

describe('formatLink', () => {
  it('round-trips through parseLink', () => {
    const link = { module: 'kv' as const, conn: 'c1', bucket: 'config', key: 'line/1', from: 5, to: 9 };
    expect(parseLink(formatLink(link))).toEqual(link);
  });

  it('is empty without a module', () => {
    expect(formatLink({ conn: 'abc' })).toBe('');
  });

  it('leaves the query out when there is nothing to say', () => {
    expect(formatLink({ module: 'alerts' })).toBe('#/alerts');
  });
});

describe('linkFromState', () => {
  const state = {
    module: 'subjects' as const,
    activeConnId: 'c1',
    selectedSubject: 'plant.temp',
    range: { from: 1, to: 2 },
    selectedStream: 'ORDERS',
    selectedKvBucket: 'cfg',
    selectedKvKey: 'k',
    selectedObjStore: 'files',
    selectedService: 'svc',
    selectedTemplateId: 't1',
  };

  it('carries only the selection of the current module', () => {
    expect(linkFromState(state)).toEqual({ module: 'subjects', conn: 'c1', subject: 'plant.temp', from: 1, to: 2 });
    expect(linkFromState({ ...state, module: 'kv' })).toEqual({ module: 'kv', conn: 'c1', bucket: 'cfg', key: 'k' });
    expect(linkFromState({ ...state, module: 'monitor' })).toEqual({ module: 'monitor', conn: 'c1' });
  });

  it('drops the window with the subject and the key with the bucket', () => {
    expect(linkFromState({ ...state, selectedSubject: null })).toEqual({ module: 'subjects', conn: 'c1' });
    expect(linkFromState({ ...state, module: 'kv', selectedKvBucket: null })).toEqual({ module: 'kv', conn: 'c1' });
  });
});

describe('linkTarget', () => {
  it('ignores the window, so a zoom is not a jump', () => {
    expect(linkTarget({ module: 'subjects', subject: 'a', from: 1, to: 2 })).toBe(linkTarget({ module: 'subjects', subject: 'a' }));
    expect(linkTarget({ module: 'subjects', subject: 'a' })).not.toBe(linkTarget({ module: 'subjects', subject: 'b' }));
  });
});
