import { describe, expect, it } from 'vitest';
import type { ConsumerInfo, StreamInfo } from 'shared';
import { CARD_W, cardHeight, layoutRelations, streamKind } from './relationsLayout';

function stream(name: string, over: Partial<StreamInfo> = {}): StreamInfo {
  return { name, subjects: [], state: { messages: 0, bytes: 0, consumerCount: 0 }, ...over } as unknown as StreamInfo;
}

describe('layoutRelations', () => {
  const streams = [
    stream('ORDERS', { subjects: ['orders.>'] }),
    stream('SENSORS', { subjects: ['sensors.>', 'a', 'b', 'c', 'd'] }),
    stream('BACKUP', { mirror: { name: 'ORDERS', lag: 3 } }),
    stream('ARCHIVE', { sources: [{ name: 'ORDERS' }, { name: 'SENSORS' }, { name: 'FAR', domain: 'edge' }] }),
    stream('COPY_OF_ARCHIVE', { mirror: { name: 'ARCHIVE' } }),
  ];
  const consumers = new Map<string, ConsumerInfo[]>([['ORDERS', [{ name: 'billing' } as ConsumerInfo]]]);
  const lay = layoutRelations(streams, consumers, { subjects: true });
  const card = (n: string) => lay.cards.find(c => c.name === n)!;

  it('puts a stream one column right of what it copies from', () => {
    expect(card('ORDERS').level).toBe(1);
    expect(card('SENSORS').level).toBe(1);
    expect(card('BACKUP').level).toBe(2);
    expect(card('ARCHIVE').level).toBe(2);
    expect(card('COPY_OF_ARCHIVE').level).toBe(3);
    expect(card('BACKUP').x).toBeGreaterThan(card('ORDERS').x + CARD_W);
  });

  it('keeps cards of a column from overlapping', () => {
    for (const a of lay.cards)
      for (const b of lay.cards) {
        if (a === b || a.level !== b.level) continue;
        expect(a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
      }
  });

  it('links the subjects, the mirror and the sources, and shows a foreign source as a chip', () => {
    const kinds = lay.links.map(l => `${l.kind}:${l.from}->${l.to}`);
    expect(kinds).toContain('subject:subject:orders.>->ORDERS');
    expect(kinds).toContain('mirror:ORDERS->BACKUP');
    expect(kinds).toContain('source:SENSORS->ARCHIVE');
    expect(kinds).toContain('mirror:ARCHIVE->COPY_OF_ARCHIVE');
    expect(lay.chips.find(c => c.kind === 'external')).toMatchObject({ label: 'FAR', detail: 'edge' });
    expect(lay.links.find(l => l.kind === 'mirror' && l.to === 'BACKUP')!.lag).toBe(3);
  });

  it('shows a few subjects of a stream and counts the rest', () => {
    expect(lay.chips.filter(c => c.kind === 'subject' && c.detail === 'SENSORS')).toHaveLength(4);
    expect(lay.chips.find(c => c.kind === 'more')!.label).toBe('+1 more');
  });

  it('grows a card with its consumers', () => {
    expect(card('ORDERS').h).toBe(cardHeight(1, false));
    expect(card('ORDERS').h).toBeGreaterThan(card('SENSORS').h);
  });

  it('survives two streams sourcing from each other', () => {
    const loop = layoutRelations([stream('A', { sources: [{ name: 'B' }] }), stream('B', { sources: [{ name: 'A' }] })], new Map(), { subjects: false });
    expect(loop.cards).toHaveLength(2);
  });

  it('tells the backing streams apart', () => {
    expect(streamKind('KV_config')).toBe('kv');
    expect(streamKind('OBJ_files')).toBe('objects');
    expect(streamKind('ORDERS')).toBe('stream');
  });
});
