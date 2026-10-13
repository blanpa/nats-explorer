import type { ConsumerInfo, StreamInfo } from 'shared';

/**
 * Where the boxes of the relations picture go. Streams stand in columns by
 * how far they are from where data comes in: a stream that takes its
 * subjects from publishers is in the first column, a mirror or a source of
 * it in the next, and so on. The subjects a stream stores, and a stream
 * from another domain or account that something sources from, stand left
 * of everything. Plain geometry, so it can be tested without a browser.
 */

export const CARD_W = 232;
const COL_GAP = 120;
const ROW_GAP = 22;
export const CHIP_W = 180;
export const CHIP_H = 22;
const CHIP_GAP = 6;
const MARGIN = 20;
const HEADER_H = 50;
export const CONSUMER_ROW_H = 20;
export const MAX_CONSUMER_ROWS = 5;
export const MAX_SUBJECT_CHIPS = 4;

export type StreamKind = 'stream' | 'kv' | 'objects';

export function streamKind(name: string): StreamKind {
  return name.startsWith('KV_') ? 'kv' : name.startsWith('OBJ_') ? 'objects' : 'stream';
}

export interface LaidCard {
  name: string;
  kind: StreamKind;
  level: number;
  x: number;
  y: number;
  h: number;
  stream: StreamInfo;
  consumers: ConsumerInfo[];
}

export interface LaidChip {
  /** subject:<pattern>, external:<name> or more:<stream> */
  id: string;
  kind: 'subject' | 'external' | 'more';
  label: string;
  /** the stream a subject chip feeds, or the domain or API of an external */
  detail?: string;
  x: number;
  y: number;
}

export interface LaidLink {
  key: string;
  kind: 'subject' | 'mirror' | 'source';
  from: string;
  to: string;
  d: string;
  /** messages behind, for a mirror or a source */
  lag?: number;
  mx: number;
  my: number;
}

export interface RelationsLayout {
  width: number;
  height: number;
  cards: LaidCard[];
  chips: LaidChip[];
  links: LaidLink[];
}

interface Upstream {
  name: string;
  kind: 'mirror' | 'source';
  /** set for a stream that is not in this listing: another domain or account */
  external?: string;
  lag?: number;
}

function upstreamsOf(s: StreamInfo, known: Set<string>): Upstream[] {
  const out: Upstream[] = [];
  const add = (src: NonNullable<StreamInfo['mirror']>, kind: 'mirror' | 'source') => {
    const foreign = src.domain || src.externalApi;
    out.push({ name: src.name, kind, external: foreign || !known.has(src.name) ? foreign || 'not listed' : undefined, lag: src.lag });
  };
  if (s.mirror) add(s.mirror, 'mirror');
  for (const src of s.sources ?? []) add(src, 'source');
  return out;
}

export function cardHeight(consumers: number, republish: boolean): number {
  const rows = Math.min(consumers, MAX_CONSUMER_ROWS) + (consumers > MAX_CONSUMER_ROWS ? 1 : 0);
  return HEADER_H + (rows ? rows * CONSUMER_ROW_H + 8 : 0) + (republish ? CONSUMER_ROW_H : 0);
}

const curve = (x1: number, y1: number, x2: number, y2: number) => {
  const dx = Math.max(30, (x2 - x1) / 2);
  return `M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + dx).toFixed(1)},${y1.toFixed(1)} ${(x2 - dx).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
};

export function layoutRelations(streams: StreamInfo[], consumers: Map<string, ConsumerInfo[]>, opts: { subjects: boolean }): RelationsLayout {
  const byName = new Map(streams.map(s => [s.name, s]));
  const known = new Set(byName.keys());
  const ups = new Map(streams.map(s => [s.name, upstreamsOf(s, known)]));

  // Levels: one more than the deepest stream it copies from. A cycle --
  // two streams sourcing from each other -- is cut where it closes.
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (name: string): number => {
    const done = level.get(name);
    if (done !== undefined) return done;
    if (visiting.has(name)) return 1;
    visiting.add(name);
    let l = 1;
    for (const u of ups.get(name) ?? []) if (!u.external) l = Math.max(l, levelOf(u.name) + 1);
    visiting.delete(name);
    level.set(name, l);
    return l;
  };
  for (const s of streams) levelOf(s.name);

  const left = MARGIN + (opts.subjects || streams.some(s => (ups.get(s.name) ?? []).some(u => u.external)) ? CHIP_W + COL_GAP : 0);
  const colX = (l: number) => left + (l - 1) * (CARD_W + COL_GAP);

  // Column by column, each stream as near the middle of what feeds it as
  // the ones before allow: fewer crossing lines than alphabetical order.
  const maxLevel = Math.max(1, ...level.values());
  const cards: LaidCard[] = [];
  const cardOf = new Map<string, LaidCard>();
  let bottom = MARGIN;
  for (let l = 1; l <= maxLevel; l++) {
    const names = streams.filter(s => level.get(s.name) === l).map(s => s.name);
    const center = (name: string) => {
      const ys = (ups.get(name) ?? [])
        .map(u => cardOf.get(u.name))
        .filter((c): c is LaidCard => !!c)
        .map(c => c.y + c.h / 2);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Number.POSITIVE_INFINITY;
    };
    names.sort((a, b) => {
      const d = center(a) - center(b);
      return Number.isFinite(d) && d !== 0 ? d : a.localeCompare(b);
    });
    let y = MARGIN;
    for (const name of names) {
      const s = byName.get(name)!;
      const cs = consumers.get(name) ?? [];
      const h = cardHeight(cs.length, !!s.republish);
      const want = center(name);
      if (Number.isFinite(want)) y = Math.max(y, want - h / 2);
      const card: LaidCard = { name, kind: streamKind(name), level: l, x: colX(l), y, h, stream: s, consumers: cs };
      cards.push(card);
      cardOf.set(name, card);
      y += h + ROW_GAP;
      bottom = Math.max(bottom, card.y + card.h);
    }
  }

  // The left column: the subjects of each stream and the foreign streams
  // copied from, in the order of what they feed.
  const chips: LaidChip[] = [];
  const links: LaidLink[] = [];
  const chipX = MARGIN;
  let free = MARGIN;
  const anchorY = (c: LaidCard) => c.y + 18;
  for (const card of [...cards].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const items: LaidChip[] = [];
    if (opts.subjects) {
      const subjects = card.stream.subjects ?? [];
      for (const subj of subjects.slice(0, MAX_SUBJECT_CHIPS))
        items.push({ id: `subject:${subj}`, kind: 'subject', label: subj, detail: card.name, x: chipX, y: 0 });
      if (subjects.length > MAX_SUBJECT_CHIPS)
        items.push({ id: `more:${card.name}`, kind: 'more', label: `+${subjects.length - MAX_SUBJECT_CHIPS} more`, detail: card.name, x: chipX, y: 0 });
    }
    for (const u of ups.get(card.name) ?? []) {
      if (u.external) items.push({ id: `external:${u.name}:${u.external}`, kind: 'external', label: u.name, detail: u.external, x: chipX, y: 0 });
    }
    if (!items.length) continue;
    let y = Math.max(free, anchorY(card) - CHIP_H / 2);
    for (const item of items) {
      if (chips.some(c => c.id === item.id)) continue;
      item.y = y;
      chips.push(item);
      y += CHIP_H + CHIP_GAP;
    }
    free = y + ROW_GAP / 2;
    bottom = Math.max(bottom, y);
  }

  const chipById = new Map(chips.map(c => [c.id, c]));
  for (const card of cards) {
    const incoming = [...(opts.subjects ? (card.stream.subjects ?? []).slice(0, MAX_SUBJECT_CHIPS).map(s => `subject:${s}`) : [])];
    if (opts.subjects && (card.stream.subjects?.length ?? 0) > MAX_SUBJECT_CHIPS) incoming.push(`more:${card.name}`);
    for (const id of incoming) {
      const chip = chipById.get(id);
      if (!chip) continue;
      const x1 = chip.x + CHIP_W;
      const y1 = chip.y + CHIP_H / 2;
      const x2 = card.x;
      const y2 = anchorY(card);
      links.push({ key: `${id}->${card.name}`, kind: 'subject', from: id, to: card.name, d: curve(x1, y1, x2, y2), mx: (x1 + x2) / 2, my: (y1 + y2) / 2 });
    }
    (ups.get(card.name) ?? []).forEach((u, i) => {
      const fromCard = u.external ? undefined : cardOf.get(u.name);
      const chip = u.external ? chipById.get(`external:${u.name}:${u.external}`) : undefined;
      if (!fromCard && !chip) return;
      const x1 = fromCard ? fromCard.x + CARD_W : chip!.x + CHIP_W;
      const y1 = fromCard ? anchorY(fromCard) : chip!.y + CHIP_H / 2;
      const x2 = card.x;
      const y2 = anchorY(card) + i * 6;
      links.push({
        key: `${u.kind}:${u.name}->${card.name}`,
        kind: u.kind,
        from: fromCard ? u.name : chip!.id,
        to: card.name,
        d: curve(x1, y1, x2, y2),
        lag: u.lag,
        mx: (x1 + x2) / 2,
        my: (y1 + y2) / 2,
      });
    });
  }

  const width = Math.max(colX(maxLevel) + CARD_W + MARGIN, 360);
  return { width, height: bottom + MARGIN, cards, chips, links };
}
