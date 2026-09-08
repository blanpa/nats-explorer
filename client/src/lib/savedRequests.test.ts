import { describe, expect, it } from 'vitest';
import { newSavedRequest, parseCollection, serializeCollection } from './savedRequests';

describe('savedRequests', () => {
  it('round-trips through the export envelope', () => {
    const items = [
      newSavedRequest({
        id: 'a',
        name: 'Lookup',
        mode: 'request',
        subject: 'inventory.lookup',
        payload: '{"sku":"{{i}}"}',
        headers: [{ key: 'X-Trace', value: '{{uuid}}' }],
        count: 100,
        concurrency: 8,
        timeout: 2000,
      }),
      newSavedRequest({ id: 'b', subject: 'orders.new' }),
    ];
    const back = parseCollection(serializeCollection(items));
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({
      id: 'a',
      name: 'Lookup',
      mode: 'request',
      count: 100,
      concurrency: 8,
      timeout: 2000,
      headers: [{ key: 'X-Trace', value: '{{uuid}}' }],
    });
    expect(back[1].mode).toBe('publish');
  });

  it('accepts a bare array and drops malformed entries', () => {
    const back = parseCollection(
      JSON.stringify([{ subject: 's', mode: 'weird', headers: [{ key: '', value: 'x' }, { key: 'k' }], count: -1 }, { name: 'no subject' }, 42]),
    );
    expect(back).toHaveLength(1);
    expect(back[0].mode).toBe('publish');
    expect(back[0].headers).toEqual([{ key: 'k', value: '' }]);
    expect(back[0].count).toBeUndefined();
    expect(back[0].id).toMatch(/[0-9a-f-]{36}/);
  });

  it('rejects non-JSON', () => {
    expect(() => parseCollection('nope')).toThrow();
  });
});

import { draftDiffers, draftFromSaved, emptyDraft, savedFromDraft } from './savedRequests';

describe('request drafts', () => {
  it('round-trips a template through a draft and detects changes', () => {
    const t = newSavedRequest({
      id: 't',
      name: 'T',
      mode: 'request',
      subject: 's',
      payload: 'p',
      headers: [{ key: 'k', value: 'v' }],
      timeout: 1000,
      count: 10,
      concurrency: 2,
    });
    const d = draftFromSaved(t);
    expect(d).toMatchObject({ mode: 'request', timeout: 1000, count: 10, concurrency: 2, intervalMs: 0 });
    expect(draftDiffers(d, t)).toBe(false);
    expect(draftDiffers({ ...d, payload: 'x' }, t)).toBe(true);
    const back = savedFromDraft({ ...d, count: 1 }, t);
    expect(back.count).toBeUndefined();
    expect(back.name).toBe('T');
    expect(emptyDraft('a.b').subject).toBe('a.b');
  });
});
