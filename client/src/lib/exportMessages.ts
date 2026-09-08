import type { NatsMessage, StreamMessage } from 'shared';

export type ExportFormat = 'json' | 'csv';

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

/** Serialises rows as a JSON array or as CSV with a header line. */
export function serializeMessages(rows: ExportRow[], format: ExportFormat): string {
  if (format === 'json') return JSON.stringify(rows, null, 2);
  const lines = ['timestamp,time,sequence,subject,payloadType,size,payload'];
  for (const r of rows) {
    lines.push([r.timestamp, new Date(r.timestamp).toISOString(), r.sequence ?? '', r.subject, r.payloadType, r.size, r.payload].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

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
  downloadText(serializeMessages(messages.map(rowOf), format), `${safe}-${stamp}.${format}`, format === 'json' ? 'application/json' : 'text/csv');
}
