import { create } from 'zustand';
import { readSetting, uuid, writeSetting } from './utils';

/**
 * Payload decoders: a rule maps a subject pattern to a wire format and, for
 * schema formats, the schema to decode with. Rules live in the settings
 * (browser storage or the backend's settings file) under ne.decoders.v1.
 * The libraries load on first use so the main bundle stays small.
 */

export type DecoderFormat = 'msgpack' | 'protobuf' | 'avro';

export interface DecoderRule {
  id: string;
  /** NATS subject pattern; `*` matches one token, `>` the rest */
  pattern: string;
  format: DecoderFormat;
  /** .proto source or Avro schema JSON; unused for msgpack */
  schema?: string;
  /** fully qualified protobuf message type, e.g. acme.Telemetry */
  messageType?: string;
}

export const FORMAT_LABELS: Record<DecoderFormat, string> = { msgpack: 'MessagePack', protobuf: 'Protocol Buffers', avro: 'Avro' };

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
