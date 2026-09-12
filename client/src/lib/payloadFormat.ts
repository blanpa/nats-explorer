import { type DecoderRule, encodeWith, findRule } from './decoders';

/**
 * What the text in a payload editor means, and what it becomes on the wire.
 *
 * NATS carries bytes and says nothing about them, so the format is the
 * author's declaration of intent: the same editor holds a JSON document, an
 * XML body, or the hex of a firmware frame. Four of the seven are text and
 * travel as they are written; hex, base64 and protobuf are ways of writing
 * bytes that no text editor could hold, and they are decoded before sending.
 *
 * The editor keeps what was typed, never the encoded form -- switching the
 * format back and forth must not rewrite anyone's payload.
 */
export type PayloadFormat = 'json' | 'text' | 'xml' | 'html' | 'hex' | 'base64' | 'protobuf';

export const PAYLOAD_FORMATS: { id: PayloadFormat; label: string; hint: string }[] = [
  { id: 'json', label: 'JSON', hint: 'Checked as it is typed and formatted on request; the pinned schema judges it.' },
  { id: 'text', label: 'Text', hint: 'Sent as written, in UTF-8. Nothing is checked.' },
  { id: 'xml', label: 'XML', hint: 'Sent as text; the document is parsed as you type and can be indented.' },
  { id: 'html', label: 'HTML', hint: 'Sent as text. HTML parses no matter what it says, so nothing is claimed about it.' },
  { id: 'hex', label: 'Hex', hint: 'The bytes written out: "de ad be ef", "DEADBEEF", 0x and colons are all read.' },
  { id: 'base64', label: 'Base64', hint: 'The bytes as base64; whitespace and line breaks are ignored.' },
  { id: 'protobuf', label: 'Protobuf', hint: 'JSON here, encoded with the .proto of the payload decoder whose pattern matches the subject.' },
];

/** Formats that are bytes written as text; the wire gets the bytes. */
export const isBinaryFormat = (f: PayloadFormat) => f === 'hex' || f === 'base64' || f === 'protobuf';

/** A payload ready for the API: text as it stands, or bytes as base64. */
export interface WirePayload {
  payload: string;
  /** "binary": the payload is base64 and the server sends the bytes */
  payloadType?: 'binary';
}

const encoder = new TextEncoder();

/** Hex as people write it: spaces, newlines, `0x`, colons and commas are noise. */
export function parseHex(text: string): Uint8Array | null {
  const clean = text
    .replace(/0x/gi, '')
    .replace(/[\s:,_-]/g, '')
    .trim();
  if (clean === '') return new Uint8Array();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Base64 as people paste it: line breaks and spaces are not part of it. */
export function parseBase64(text: string): Uint8Array | null {
  const clean = text.replace(/\s/g, '');
  if (clean === '') return new Uint8Array();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  try {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Bytes as base64: the form that survives a paste into any other tool. */
export const toBase64 = (bytes: Uint8Array) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** The same, in lines short enough to read. */
export const wrapBase64 = (text: string) => text.match(/.{1,76}/g)?.join('\n') ?? text;

/**
 * How many bytes the message will carry, or null when the text is not that
 * format yet. Protobuf needs its schema and cannot answer without asking the
 * encoder, so it says nothing rather than guessing.
 */
export function wireLength(format: PayloadFormat, text: string): number | null {
  if (format === 'hex') return parseHex(text)?.length ?? null;
  if (format === 'base64') return parseBase64(text)?.length ?? null;
  if (format === 'protobuf') return null;
  return encoder.encode(text).length;
}

/**
 * A payload that carries run placeholders is not JSON yet -- `{"n": {{i}}}`
 * parses only once the run has put a number there. For the check, every
 * placeholder stands in as `1`: a number where a value is expected, and a
 * character where it sits inside a string.
 */
const withoutPlaceholders = (text: string) => text.replace(/\{\{[^{}]*\}\}/g, '1');

const parseXml = (text: string): string | null => {
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (!err) return null;
  // Browsers word this differently; the first line is the useful part.
  return (err.textContent ?? 'not well-formed').trim().split('\n')[0];
};

/**
 * What is wrong with the text for the format it claims to be, as one line,
 * or null when there is nothing to say. A problem is a warning, not a gate:
 * only the formats that cannot be sent at all refuse (see `toWire`).
 */
export function payloadProblem(format: PayloadFormat, text: string): string | null {
  if (text.trim() === '') return null;
  switch (format) {
    case 'json':
    case 'protobuf':
      try {
        JSON.parse(withoutPlaceholders(text));
        return null;
      } catch {
        return 'Not JSON: it will be sent as it stands.';
      }
    case 'xml': {
      const err = parseXml(text);
      return err ? `Not well-formed XML: ${err}` : null;
    }
    case 'hex':
      return parseHex(text) ? null : 'Not hex: an even number of 0-9 a-f digits, spaces and 0x aside.';
    case 'base64':
      return parseBase64(text) ? null : 'Not base64.';
    default:
      return null;
  }
}

/**
 * Which markup a payload is written in, from its first tag: `<?xml` and a
 * root element that is not an HTML one say XML, `<!doctype html>` and the
 * usual suspects say HTML. Null when it is not markup at all.
 */
export function markupOf(text: string): 'xml' | 'html' | null {
  const t = text.trimStart();
  if (!t.startsWith('<')) return null;
  if (/^<\?xml/i.test(t)) return 'xml';
  if (/^<!doctype\s+html/i.test(t) || /^<(html|head|body|div|p|span|table|ul|ol|section|article|a|img|h[1-6])\b/i.test(t)) return 'html';
  return /^<[a-z_:][\w.:-]*[\s/>]/i.test(t) ? 'xml' : null;
}

/** HTML elements that never close; treating them as open would drift the indent. */
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Indents XML or HTML by its tags. Text inside a tag stays on its line. */
export function prettyXml(text: string): string {
  const lines = text.replace(/>\s*</g, '><').replace(/></g, '>\n<').split('\n');
  let depth = 0;
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const closing = t.startsWith('</');
    // A tag that closes itself, a declaration, or an element opened and
    // closed again on the same line leaves the level where it is.
    const tag = /^<\/?([^\s>/]+)/.exec(t)?.[1]?.toLowerCase() ?? '';
    const flat = closing || t.endsWith('/>') || /^<[!?]/.test(t) || VOID_ELEMENTS.has(tag) || /^<([^\s>/]+)[^>]*>.*<\/\1>$/.test(t);
    if (closing) depth = Math.max(0, depth - 1);
    out.push('  '.repeat(depth) + t);
    if (!flat) depth++;
  }
  return out.join('\n');
}

/** The tidied form of the text, or null when the format has no tidier. */
export function prettyPayload(format: PayloadFormat, text: string): string | null {
  switch (format) {
    case 'json':
    case 'protobuf':
      try {
        return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
      } catch {
        return null;
      }
    case 'xml':
      return parseXml(text) === null ? prettyXml(text) : null;
    case 'html':
      return prettyXml(text);
    case 'hex': {
      const bytes = parseHex(text);
      if (!bytes) return null;
      return [...bytes]
        .map(b => b.toString(16).padStart(2, '0'))
        .join(' ')
        .replace(/((?:[0-9a-f]{2} ){16})/g, '$1\n')
        .trim();
    }
    case 'base64': {
      const bytes = parseBase64(text);
      return bytes
        ? (toBase64(bytes)
            .match(/.{1,76}/g)
            ?.join('\n') ?? '')
        : null;
    }
    default:
      return null;
  }
}

/**
 * The payload as the API takes it. Text formats go as they are -- a payload
 * that does not parse is still a payload, and refusing to send it would take
 * away the one tool for reproducing what a broken producer did. The binary
 * formats are the exception: half a hex byte is not a message, and there is
 * nothing to send.
 */
export async function toWire(format: PayloadFormat, text: string, subject: string, rules: DecoderRule[]): Promise<WirePayload> {
  if (format === 'hex' || format === 'base64') {
    const bytes = format === 'hex' ? parseHex(text) : parseBase64(text);
    if (!bytes) throw new Error(payloadProblem(format, text) ?? `not ${format}`);
    return { payload: toBase64(bytes), payloadType: 'binary' };
  }
  if (format === 'protobuf') {
    const rule = findRule(rules, subject);
    if (!rule) throw new Error(`no payload decoder matches ${subject || 'this subject'}; add one to encode with its .proto`);
    if (rule.format !== 'protobuf') throw new Error(`the decoder for ${rule.pattern} is ${rule.format}, not protobuf`);
    let value: unknown;
    try {
      value = JSON.parse(text || '{}');
    } catch {
      throw new Error('a protobuf message is written as JSON here, and this is not JSON');
    }
    return { payload: toBase64(await encodeWith(rule, value)), payloadType: 'binary' };
  }
  return { payload: text };
}
