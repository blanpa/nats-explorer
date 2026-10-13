import { create } from 'zustand';
import { readSetting, uuid, writeSetting } from './utils';

/**
 * Payload decoders: a rule maps a subject pattern to a wire format and, for
 * schema formats, the schema to decode with. Rules live in the settings
 * (browser storage or the backend's settings file) under ne.decoders.v1.
 * The libraries load on first use so the main bundle stays small.
 */

export type DecoderFormat = 'msgpack' | 'protobuf' | 'avro' | 'script';

export interface DecoderRule {
  id: string;
  /** NATS subject pattern; `*` matches one token, `>` the rest */
  pattern: string;
  format: DecoderFormat;
  /** .proto source, Avro schema JSON, or the body of a JavaScript function; unused for msgpack */
  schema?: string;
  /** fully qualified protobuf message type, e.g. acme.Telemetry */
  messageType?: string;
}

export const FORMAT_LABELS: Record<DecoderFormat, string> = { msgpack: 'MessagePack', protobuf: 'Protocol Buffers', avro: 'Avro', script: 'JavaScript' };

/**
 * What a script decoder is handed beside the bytes: the readers a house
 * format needs, so the body can say `view.getUint16(0)` and `text(bytes)`
 * instead of building them.
 */
export interface ScriptHelpers {
  /** the bytes as a DataView, for fixed-width fields */
  view: DataView;
  /** the bytes as UTF-8 text */
  text: (b?: Uint8Array) => string;
  /** the bytes as JSON */
  json: (b?: Uint8Array) => unknown;
  /** the bytes as hex, for a preview or a lookup */
  hex: (b?: Uint8Array) => string;
}

/**
 * Compiles the body of a script rule: a function of `bytes` and `helpers`
 * that returns the decoded value. It runs in this browser, like a
 * userscript, and only for the rules written here; a body that does not
 * compile says so once, when the rule is saved.
 */
export function compileScript(body: string): (bytes: Uint8Array) => unknown {
  if (!body.trim()) throw new Error('write the body of a function: it gets bytes and helpers, and returns the value');
  const fn = new Function('bytes', 'helpers', body) as (bytes: Uint8Array, helpers: ScriptHelpers) => unknown;
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return bytes => {
    const helpers: ScriptHelpers = {
      view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      text: (b = bytes) => text(b),
      json: (b = bytes) => JSON.parse(text(b)),
      hex: (b = bytes) => Array.from(b, x => x.toString(16).padStart(2, '0')).join(''),
    };
    return fn(bytes, helpers);
  };
}

const KEY = 'ne.decoders.v1';

/** Whether a NATS subject pattern matches a subject. */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split('.');
  const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

export function findRule(rules: DecoderRule[], subject: string | undefined): DecoderRule | undefined {
  if (!subject) return undefined;
  return rules.find(r => subjectMatches(r.pattern, subject));
}

export type Decoded = { ok: true; value: unknown } | { ok: false; error: string };

type Decoder = (bytes: Uint8Array) => unknown;

const compiled = new Map<string, Promise<Decoder>>();

function cacheKey(rule: DecoderRule): string {
  return `${rule.format} ${rule.schema ?? ''} ${rule.messageType ?? ''}`;
}

async function compile(rule: DecoderRule): Promise<Decoder> {
  switch (rule.format) {
    case 'msgpack': {
      const { decode } = await import('@msgpack/msgpack');
      return bytes => decode(bytes);
    }
    case 'protobuf': {
      const protobuf = await import('protobufjs');
      if (!rule.schema?.trim()) throw new Error('paste the .proto source into the rule');
      const { root } = protobuf.parse(rule.schema, { keepCase: true });
      const name = rule.messageType?.trim();
      const type = name ? root.lookupType(name) : firstMessage(root);
      if (!type) throw new Error('the .proto defines no message type');
      return bytes => type.toObject(type.decode(bytes), { longs: String, enums: String, bytes: String, defaults: true });
    }
    case 'avro': {
      const avro = await import('avsc');
      if (!rule.schema?.trim()) throw new Error('paste the Avro schema JSON into the rule');
      const { Buffer } = await import('buffer');
      const type = avro.Type.forSchema(JSON.parse(rule.schema));
      return bytes => plain(type.fromBuffer(Buffer.from(bytes)));
    }
    case 'script':
      return compileScript(rule.schema ?? '');
  }
}

type PbNamespace = import('protobufjs').NamespaceBase;
type PbType = import('protobufjs').Type;

function firstMessage(ns: PbNamespace): PbType | undefined {
  for (const nested of ns.nestedArray) {
    if ('fields' in nested && 'decode' in nested) return nested as PbType;
    if ('nestedArray' in nested) {
      const found = firstMessage(nested as PbNamespace);
      if (found) return found;
    }
  }
  return undefined;
}

/** Avro records come back as class instances with Buffers inside; make them plain JSON. */
function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Uint8Array) return Array.from(v);
  if (Array.isArray(v)) return v.map(plain);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = plain(val);
  return out;
}

/**
 * The message types a `.proto` defines, fully qualified and in the order
 * they are written. Typing `acme.Reading` from memory is how a rule ends up
 * decoding nothing, and the file already says what is in it.
 */
export async function messageTypesOf(schema: string): Promise<string[]> {
  if (!schema.trim()) return [];
  const protobuf = await import('protobufjs');
  const { root } = protobuf.parse(schema, { keepCase: true });
  const out: string[] = [];
  const walk = (ns: PbNamespace) => {
    for (const nested of ns.nestedArray) {
      if ('fields' in nested && 'decode' in nested) out.push(nested.fullName.replace(/^\./, ''));
      if ('nestedArray' in nested) walk(nested as PbNamespace);
    }
  };
  walk(root);
  return out;
}

/**
 * Encodes a value with a rule's schema: the way back through the same
 * `.proto` the payloads are read with. Only protobuf, because that is the
 * one format where writing a message by hand is otherwise out of reach --
 * MessagePack and Avro can wait until someone needs them.
 *
 * Errors are thrown rather than returned: a payload that cannot be encoded
 * must not be sent, which is the opposite of a decode, where showing the
 * bytes as they came is still an answer.
 */
export async function encodeWith(rule: DecoderRule, value: unknown): Promise<Uint8Array> {
  if (rule.format !== 'protobuf') throw new Error(`${FORMAT_LABELS[rule.format]} payloads cannot be written here yet`);
  const protobuf = await import('protobufjs');
  if (!rule.schema?.trim()) throw new Error('paste the .proto source into the rule');
  const { root } = protobuf.parse(rule.schema, { keepCase: true });
  const name = rule.messageType?.trim();
  const type = name ? root.lookupType(name) : firstMessage(root);
  if (!type) throw new Error('the .proto defines no message type');
  const bad = type.verify(value as Record<string, unknown>);
  if (bad) throw new Error(bad);
  return type.encode(type.fromObject(value as Record<string, unknown>)).finish();
}

/** Decodes bytes with a rule; compile errors and decode errors both come back as `ok: false`. */
export async function decodeWith(rule: DecoderRule, bytes: Uint8Array): Promise<Decoded> {
  const key = cacheKey(rule);
  let dec = compiled.get(key);
  if (!dec) {
    dec = compile(rule);
    compiled.set(key, dec);
    dec.catch(() => compiled.delete(key));
  }
  try {
    return { ok: true, value: (await dec)(bytes) };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

interface DecoderState {
  rules: DecoderRule[];
  save: (rule: DecoderRule) => void;
  remove: (id: string) => void;
  /** re-reads the settings, e.g. after the backend entries were seeded */
  reload: () => void;
}

function load(): DecoderRule[] {
  const raw = readSetting<unknown>(KEY, []);
  return Array.isArray(raw) ? (raw as DecoderRule[]).filter(r => r && typeof r.pattern === 'string' && r.format in FORMAT_LABELS) : [];
}

export const useDecoders = create<DecoderState>((set, get) => ({
  rules: load(),
  save: rule => {
    const rules = get().rules.some(r => r.id === rule.id) ? get().rules.map(r => (r.id === rule.id ? rule : r)) : [...get().rules, rule];
    writeSetting(KEY, rules);
    set({ rules });
  },
  remove: id => {
    const rules = get().rules.filter(r => r.id !== id);
    writeSetting(KEY, rules);
    set({ rules });
  },
  reload: () => set({ rules: load() }),
}));

export function newRule(partial: Partial<DecoderRule> = {}): DecoderRule {
  return { id: uuid(), pattern: '', format: 'msgpack', ...partial };
}
