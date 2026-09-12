/**
 * Reading a protobuf message without its `.proto`.
 *
 * The wire format carries field numbers and four wire types, not names and
 * not declared types: `21.5` and `4621819117588971520` are the same eight
 * bytes, and only the schema says which was meant. Without it the honest
 * answer is the one `protoc --decode_raw` gives -- the numbers that are
 * there, with the shape guessed from the bytes -- and that answer is worth
 * a lot when a device sends something nobody has a schema for.
 *
 * What is guessed, and how:
 *   - length-delimited bytes are read as text when they are printable from
 *     end to end, and as a nested message otherwise; what is neither is
 *     shown as hex. Both readings fit the same bytes -- "hi" is also a
 *     valid little message -- and strings are the commoner truth.
 *   - a 64-bit field is shown as a double when the double is a number
 *     someone would write down, and as an integer otherwise. Same for 32
 *     bits and float. This is a guess and the panel says so.
 */

export type RawValue = number | string | boolean | RawMessage | RawValue[];
export interface RawMessage {
  [field: string]: RawValue;
}

class Reader {
  constructor(
    readonly buf: Uint8Array,
    public pos = 0,
  ) {}
  get done() {
    return this.pos >= this.buf.length;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.done) throw new Error('truncated varint');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too long');
    }
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('truncated field');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** A number a reader would recognise as a measurement rather than a bit pattern. */
const readableFloat = (v: number) => Number.isFinite(v) && (v === 0 || (Math.abs(v) >= 1e-4 && Math.abs(v) < 1e13));

const number = (v: bigint): number | string => (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString());

// Text, not a bit pattern that happens to decode: control characters other
// than tab, newline and carriage return say these bytes were not a string.
function printable(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x7f) return false;
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) return false;
  }
  return true;
}

const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ');

const utf8 = new TextDecoder('utf-8', { fatal: true });

function lengthDelimited(bytes: Uint8Array, depth: number): RawValue {
  // Text first. Both readings are possible for the same bytes -- "hi" is
  // also a valid little message with field 13 in it -- and a string is what
  // people put in a protobuf field far more often than a message that
  // happens to be printable from end to end. A real nested message almost
  // always carries a control byte early: its own field tags and lengths are
  // small numbers.
  try {
    const text = utf8.decode(bytes);
    if (text.length > 0 && printable(text)) return text;
  } catch {
    // not text, so it may still be a message
  }
  if (bytes.length > 0 && depth < 12) {
    const nested = tryParse(bytes, depth + 1);
    if (nested) return nested;
  }
  return bytes.length ? `${bytes.length} bytes · ${hex(bytes.subarray(0, 32))}${bytes.length > 32 ? ' …' : ''}` : '';
}

function parse(bytes: Uint8Array, depth: number): RawMessage {
  const r = new Reader(bytes);
  const out: RawMessage = {};
  const add = (field: number, value: RawValue) => {
    const key = String(field);
    const seen = out[key];
    if (seen === undefined) out[key] = value;
    else if (Array.isArray(seen)) seen.push(value);
    else out[key] = [seen, value];
  };
  while (!r.done) {
    const key = r.varint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field === 0) throw new Error('field 0 does not exist');
    switch (wire) {
      case 0:
        add(field, number(r.varint()));
        break;
      case 1: {
        const b = r.bytes(8);
        const view = new DataView(b.buffer, b.byteOffset, 8);
        const d = view.getFloat64(0, true);
        add(field, readableFloat(d) ? d : number(view.getBigUint64(0, true)));
        break;
      }
      case 2:
        add(field, lengthDelimited(r.bytes(Number(r.varint())), depth));
        break;
      case 5: {
        const b = r.bytes(4);
        const view = new DataView(b.buffer, b.byteOffset, 4);
        const f = view.getFloat32(0, true);
        add(field, readableFloat(f) ? Number(f.toPrecision(7)) : view.getUint32(0, true));
        break;
      }
      // 3 and 4 are the groups proto2 deprecated; nobody sends them and
      // guessing at them would only produce nonsense.
      default:
        throw new Error(`wire type ${wire} is not supported`);
    }
  }
  return out;
}

/** The message, or null when these bytes are not a protobuf message. */
export function tryParse(bytes: Uint8Array, depth = 0): RawMessage | null {
  try {
    const msg = parse(bytes, depth);
    return Object.keys(msg).length > 0 ? msg : null;
  } catch {
    return null;
  }
}

/**
 * What the payload looks like with no schema to hand, or null when it is not
 * protobuf at all. The keys are field numbers as strings, so the same tree
 * that shows JSON shows this.
 */
export function decodeRaw(bytes: Uint8Array): RawMessage | null {
  return tryParse(bytes, 0);
}

/** How many fields deep the guess goes, for the line above the tree. */
export function countFields(msg: RawMessage): number {
  let n = 0;
  for (const value of Object.values(msg)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      n++;
      if (v && typeof v === 'object' && !Array.isArray(v)) n += countFields(v as RawMessage);
    }
  }
  return n;
}
