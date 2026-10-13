import { describe, expect, it } from 'vitest';
import { duplicateOf, formatMetadata, parseMetadata, sourceDraft, sourceFromDraft } from './streamForm';
import type { StreamInfo } from 'shared';

describe('metadata', () => {
  it('reads key=value lines and skips the empty ones', () => {
    expect(parseMetadata('owner=plant\n\n team = data \nflag')).toEqual({ owner: 'plant', team: 'data', flag: '' });
    expect(parseMetadata('a=b=c')).toEqual({ a: 'b=c' });
    expect(parseMetadata('')).toEqual({});
  });

  it('round-trips through the text', () => {
    const md = { owner: 'plant', url: 'http://x/y?z=1' };
    expect(parseMetadata(formatMetadata(md))).toEqual(md);
    expect(formatMetadata(undefined)).toBe('');
    expect(formatMetadata({ owner: 'plant', '_nats.ver': '2.14' })).toBe('owner=plant');
  });
});

describe('sources', () => {
  it('a row without a name is no source', () => {
    expect(sourceFromDraft({ name: '  ', filterSubject: 'a', optStartSeq: '1', optStartTime: '' })).toBeNull();
  });

  it('keeps the filter and the start where they were given', () => {
    expect(sourceFromDraft({ name: 'ORDERS', filterSubject: ' orders.eu.> ', optStartSeq: '120', optStartTime: '' })).toEqual({
      name: 'ORDERS',
      filterSubject: 'orders.eu.>',
      optStartSeq: 120,
    });
    expect(sourceFromDraft({ name: 'ORDERS', filterSubject: '', optStartSeq: 'x', optStartTime: '' })).toEqual({ name: 'ORDERS' });
  });

  it('round-trips a configured source through the draft', () => {
    const src = { name: 'ORDERS', filterSubject: 'orders.>', optStartSeq: 5 };
    expect(sourceFromDraft(sourceDraft(src))).toEqual(src);
    expect(sourceDraft().name).toBe('');
  });
});

describe('duplicateOf', () => {
  it('keeps the configuration and drops what belongs to the original', () => {
    const stream = {
      name: 'ORDERS',
      subjects: ['orders.>'],
      sealed: true,
      created: 'x',
      replicas: 3,
      cluster: { name: 'c', leader: 'l', replicas: [] },
    } as unknown as StreamInfo;
    const copy = duplicateOf(stream);
    expect(copy.name).toBe('');
    expect(copy.sealed).toBe(false);
    expect(copy.cluster).toBeUndefined();
    expect(copy.subjects).toEqual(['orders.>']);
    expect(copy.replicas).toBe(3);
  });
});
