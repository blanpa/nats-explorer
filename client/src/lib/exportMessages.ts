import type { NatsMessage, StreamMessage } from 'shared';

/**
 * What an export is for decides its shape. A JSON array is for reading, a
 * line-delimited file is for piping, a wide CSV is for a spreadsheet, and a
 * script is for putting the traffic back on a bus somewhere else.
 */
export type ExportFormat = 'json' | 'ndjson' | 'csv' | 'csv-flat' | 'payloads' | 'sh';

/** The columns shared by live messages and stream messages. */
export interface ExportRow {
  timestamp: number;
  subject: string;
  payload: string;
  payloadType: string;
  size: number;
  headers?: Record<string, string[]>;
  sequence?: number;
}

export const rowOf = (m: NatsMessage | StreamMessage): ExportRow => ({
  timestamp: m.timestamp,
  subject: m.subject,
  payload: m.payload,
  payloadType: m.payloadType,
  size: m.size,
  headers: m.headers,
  sequence: 'seq' in m ? m.seq : m.sequence,
});

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The payload as a document when it is one, otherwise null. */
function parsedPayload(r: ExportRow): unknown {
  if (r.payloadType !== 'json') return null;
  try {
    return JSON.parse(r.payload);
  } catch {
    return null;
  }
}

/**
 * A document's scalar leaves as dotted paths. Arrays are indexed rather than
 * kept whole, because a spreadsheet cannot look into a cell either way and
 * `tags.0` is at least a column that can be sorted.
 */
export function flatten(value: unknown, prefix: string, out: Record<string, string>, depth = 0): void {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object') {
    out[prefix] = value === null ? '' : String(value);
    return;
  }
  // Past the depth limit the rest goes into one cell as it is. Dropping it
  // would lose data without saying so, which is worse than a cell a
  // spreadsheet cannot look into.
  if (depth >= MAX_FLAT_DEPTH) {
    out[prefix] = JSON.stringify(value);
    return;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    out[prefix] = Array.isArray(value) ? '[]' : '{}';
    return;
  }
  for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
}

/**
 * A wide CSV would stop being a table if every message brought its own
 * fields, so the column set is capped. The columns kept are the ones seen
 * most often, which is the difference between one odd message and the shape
 * everything else has.
 */
const MAX_FLAT_COLUMNS = 250;

/** How deep a payload is spread into columns before the rest becomes one cell. */
const MAX_FLAT_DEPTH = 8;

function flatColumns(cells: Record<string, string>[]): string[] {
  const seen = new Map<string, number>();
  for (const c of cells) for (const k of Object.keys(c)) seen.set(k, (seen.get(k) ?? 0) + 1);
  const all = [...seen.entries()];
  if (all.length <= MAX_FLAT_COLUMNS) return all.map(([k]) => k).sort();
  return all
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_FLAT_COLUMNS)
    .map(([k]) => k)
    .sort();
}

/** Every header as one value, the way an expression and a column see them. */
function headerCells(r: ExportRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, vals] of Object.entries(r.headers ?? {})) if (vals?.length) out[`header.${k}`] = vals.join(', ');
  return out;
}

const FIXED_COLUMNS = ['time', 'timestamp', 'sequence', 'subject', 'payloadType', 'size'] as const;

function fixedCells(r: ExportRow): Record<string, string> {
  return {
    time: new Date(r.timestamp).toISOString(),
    timestamp: String(r.timestamp),
    sequence: r.sequence == null ? '' : String(r.sequence),
    subject: r.subject,
    payloadType: r.payloadType,
    size: String(r.size),
  };
}

/** Shell single-quoting: the only character that needs care is the quote itself. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * `nats pub` runs Go templates over the body, so a payload holding `{{`
 * would arrive changed -- `{"t":"{{Count}}"}` publishes as `{"t":"1"}`, and
 * there is no flag to turn it off. `{{"{{"}}` is the template that prints a
 * literal `{{`, which is what makes a replayed payload byte-identical.
 */
export const escapeTemplate = (s: string) => s.replace(/\{\{/g, '{{"{{"}}');

/** Serialises rows in the chosen format. */
export function serializeMessages(rows: ExportRow[], format: ExportFormat, name = 'messages'): string {
  switch (format) {
    case 'json':
      return JSON.stringify(rows, null, 2);

    // One message per line, with a JSON payload as a document rather than a
    // string: that is what makes `jq .payload.temp` and DuckDB's
    // read_json_auto() work without a second parse.
    case 'ndjson':
      return `${rows
        .map(r => {
          const doc = parsedPayload(r);
          return JSON.stringify(doc === null ? r : { ...r, payload: doc });
        })
        .join('\n')}\n`;

    case 'csv': {
      const lines = ['timestamp,time,sequence,subject,payloadType,size,headers,payload'];
      for (const r of rows) {
        const headers = r.headers && Object.keys(r.headers).length ? JSON.stringify(r.headers) : '';
        lines.push(
          [r.timestamp, new Date(r.timestamp).toISOString(), r.sequence ?? '', r.subject, r.payloadType, r.size, headers, r.payload].map(csvCell).join(','),
        );
      }
      return `${lines.join('\n')}\n`;
    }

    case 'csv-flat': {
      const cells = rows.map(r => {
        const doc = parsedPayload(r);
        const out: Record<string, string> = { ...fixedCells(r), ...headerCells(r) };
        if (doc === null) out.payload = r.payload;
        else flatten(doc, 'payload', out);
        return out;
      });
      const dynamic = flatColumns(cells).filter(c => !(FIXED_COLUMNS as readonly string[]).includes(c));
      const columns = [...FIXED_COLUMNS, ...dynamic];
      const lines = [columns.join(',')];
      for (const c of cells) lines.push(columns.map(col => csvCell(c[col] ?? '')).join(','));
      return `${lines.join('\n')}\n`;
    }

    // The payloads and nothing else. A payload holding a newline spans lines
    // here -- ndjson is the format for one record per line.
    case 'payloads':
      return `${rows.map(r => r.payload).join('\n')}\n`;

    case 'sh':
      return replayScript(rows, name);
  }
}

/** A shell script that publishes the messages again with the nats CLI. */
function replayScript(rows: ExportRow[], name: string): string {
  const binary = rows.filter(r => r.payloadType === 'binary').length;
  const out = [
    '#!/bin/sh',
    `# ${rows.length} message${rows.length === 1 ? '' : 's'} from ${name}, recorded ${new Date().toISOString()}.`,
    '#',
    '# Needs the nats CLI and a context pointing at the target server:',
    '#   nats context select <name>',
    '#   sh this-script.sh',
    '#',
    '# `nats pub` expands Go templates in the body, so every {{ is written as',
    '# {{"{{"}} to publish it literally.',
    ...(binary > 0 ? [`# ${binary} binary payload${binary === 1 ? ' goes' : 's go'} through base64 and stdin; templates apply there too.`] : []),
    '',
    '# Seconds between messages; the recording is replayed as fast as it goes by default.',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in a shell script, not a JS template
    'DELAY=${DELAY:-0}',
    '',
    'set -e',
    '',
  ];
  rows.forEach((r, i) => {
    const flags = Object.entries(r.headers ?? {})
      .flatMap(([k, vals]) => (vals ?? []).map(v => `-H ${shQuote(`${k}:${v}`)}`))
      .join(' ');
    const subject = shQuote(r.subject);
    if (r.payloadType === 'binary') {
      out.push(`printf %s ${shQuote(r.payload)} | base64 -d | nats pub ${subject} --force-stdin${flags ? ` ${flags}` : ''}`);
    } else {
      out.push(`nats pub ${subject} ${shQuote(escapeTemplate(r.payload))}${flags ? ` ${flags}` : ''}`);
    }
    if (i < rows.length - 1) out.push('[ "$DELAY" = 0 ] || sleep "$DELAY"');
  });
  return `${out.join('\n')}\n`;
}

/** How a format reaches the disk: the extension it gets and what it is. */
const FILE: Record<ExportFormat, { ext: string; mime: string }> = {
  json: { ext: 'json', mime: 'application/json' },
  ndjson: { ext: 'ndjson', mime: 'application/x-ndjson' },
  csv: { ext: 'csv', mime: 'text/csv' },
  'csv-flat': { ext: 'flat.csv', mime: 'text/csv' },
  payloads: { ext: 'payloads.txt', mime: 'text/plain' },
  sh: { ext: 'replay.sh', mime: 'text/x-shellscript' },
};

/** Hands the browser a file to save. */
export function downloadText(text: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportMessages(messages: (NatsMessage | StreamMessage)[], format: ExportFormat, name: string): void {
  const safe = name.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'messages';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const { ext, mime } = FILE[format];
  downloadText(serializeMessages(messages.map(rowOf), format, name), `${safe}-${stamp}.${ext}`, mime);
}
