import type { NatsMessage } from 'shared';
import { tryParseJson } from './utils';

/**
 * What the plant is doing right now, as a table.
 *
 * A message stream answers "what was sent"; the question in front of a
 * running system is "what is it". Those are different views of the same
 * recording: the newest message of every subject, side by side, with its
 * fields in columns and its age next to it. A row that has not moved in an
 * hour is what a subject tree cannot show and a chart cannot either.
 */

export interface StateRow {
  subject: string;
  at: number;
  /** the JSON fields of the newest message, flattened one level */
  fields: Record<string, string>;
  message: NatsMessage;
}

/** The newest message per subject, subjects in name order. */
export function stateRows(messages: NatsMessage[]): StateRow[] {
  const newest = new Map<string, NatsMessage>();
  for (const m of messages) {
    const seen = newest.get(m.subject);
    if (!seen || m.timestamp > seen.timestamp) newest.set(m.subject, m);
  }
  return [...newest.values()]
    .map(m => ({ subject: m.subject, at: m.timestamp, fields: fieldsOf(m), message: m }))
    .sort((a, b) => a.subject.localeCompare(b.subject, undefined, { numeric: true }));
}

/**
 * The values of a message as columns. One level deep and no arrays: a state
 * table is a grid, and a nested document is not one -- the payload viewer is
 * a click away for those.
 */
export function fieldsOf(message: NatsMessage): Record<string, string> {
  if (message.payloadType !== 'json') return {};
  const doc = tryParseJson(message.payload);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (v === null) out[k] = 'null';
    else if (typeof v !== 'object') out[k] = String(v);
  }
  return out;
}

/**
 * The columns the table shows: the fields most rows carry, most common
 * first. A UNS has a few fields everyone publishes and a long tail nobody
 * wants as empty columns.
 */
export function columnsOf(rows: StateRow[], max = 8): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) for (const k of Object.keys(r.fields)) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([k]) => k);
}

/** The table as CSV, for the spreadsheet this ends up in anyway. */
export function stateCsv(rows: StateRow[], columns: string[], now = Date.now()): string {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ['subject', ...columns, 'age_seconds', 'at'].map(cell).join(',');
  const lines = rows.map(r =>
    [r.subject, ...columns.map(c => r.fields[c] ?? ''), String(Math.round((now - r.at) / 1000)), new Date(r.at).toISOString()].map(cell).join(','),
  );
  return [head, ...lines].join('\n');
}
