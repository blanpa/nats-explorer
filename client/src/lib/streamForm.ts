import type { StreamInfo, StreamSource } from 'shared';

/**
 * The parts of a stream form that are text in the dialog and structures on
 * the wire: metadata as `key=value` lines, placement tags as a list, and a
 * source row with its optional start.
 */

/** `key=value` per line; a line without `=` is a key with an empty value. Blank lines are skipped. */
export function parseMetadata(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    const key = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (!key) continue;
    out[key] = eq < 0 ? '' : line.slice(eq + 1).trim();
  }
  return out;
}

/** The server keeps entries of its own under `_nats.*`; they are not the reader's to edit. */
export function formatMetadata(md: Record<string, string> | undefined): string {
  if (!md) return '';
  return Object.entries(md)
    .filter(([k]) => !k.startsWith('_nats.'))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

/** A source row as the dialog edits it: strings, so a field can be half typed. */
export interface SourceDraft {
  name: string;
  filterSubject: string;
  optStartSeq: string;
  /** datetime-local text */
  optStartTime: string;
}

export function sourceDraft(src?: StreamSource): SourceDraft {
  return {
    name: src?.name ?? '',
    filterSubject: src?.filterSubject ?? '',
    optStartSeq: src?.optStartSeq ? String(src.optStartSeq) : '',
    optStartTime: src?.optStartTime ? toLocalInput(src.optStartTime) : '',
  };
}

/** What a source row sends; null when it names no stream. */
export function sourceFromDraft(d: SourceDraft): StreamSource | null {
  const name = d.name.trim();
  if (!name) return null;
  const out: StreamSource = { name };
  if (d.filterSubject.trim()) out.filterSubject = d.filterSubject.trim();
  const seq = Number(d.optStartSeq);
  if (d.optStartSeq.trim() && Number.isFinite(seq) && seq > 0) out.optStartSeq = Math.floor(seq);
  const t = d.optStartTime ? new Date(d.optStartTime).getTime() : Number.NaN;
  if (Number.isFinite(t)) out.optStartTime = t;
  return out;
}

const toLocalInput = (ms: number) => new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/**
 * A stream's own configuration as the dialog starts from it when a copy is
 * wanted: everything but the name and what belongs to this stream alone.
 */
export function duplicateOf(stream: StreamInfo): StreamInfo {
  return { ...stream, name: '', sealed: false, created: '', cluster: undefined, sourcedBy: undefined };
}
