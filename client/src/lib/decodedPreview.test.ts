// @vitest-environment jsdom
import { encode } from '@msgpack/msgpack';
import { describe, expect, it } from 'vitest';
import { decodedPreview, previewCache, previewLine } from './decodedPreview';
import type { DecoderRule } from './decoders';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const rules: DecoderRule[] = [{ id: 'r', pattern: 'plant.>', format: 'msgpack' }];

/** The store fills in asynchronously; a row asks again on the next render. */
const settle = () => new Promise(r => setTimeout(r, 20));

describe('decodedPreview', () => {
  it('says nothing on the first ask and the decoded line on the next', async () => {
    const payload = b64(encode({ temp: 21.5, unit: 'C' }));
    const previews = new Map<string, string | null>();
    expect(decodedPreview(previews, rules, 'plant.temp', payload)).toBeNull();
    await settle();
    // The store is what a list subscribes to; a row reads it on the next render.
    expect(decodedPreview(previewCache(), rules, 'plant.temp', payload)).toContain('"temp":21.5');
  });

  it('leaves a subject without a rule alone', () => {
    expect(decodedPreview(new Map(), rules, 'other.temp', b64(encode({ a: 1 })))).toBeNull();
  });

  it('keeps a preview to one line', () => {
    expect(previewLine({ a: 'x'.repeat(200) }, 40)).toHaveLength(41);
    expect(previewLine({ a: 1 })).toBe('{"a":1}');
  });
});
