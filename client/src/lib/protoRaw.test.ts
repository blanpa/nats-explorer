// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import protobuf from 'protobufjs';
import { countFields, decodeRaw } from './protoRaw';

/** Encodes with a real .proto, so the test reads bytes nobody hand-rolled. */
function encode(proto: string, type: string, value: Record<string, unknown>): Uint8Array {
  const { root } = protobuf.parse(proto, { keepCase: true });
  const t = root.lookupType(type);
  return t.encode(t.fromObject(value)).finish();
}

const READING = `syntax = "proto3";
package acme;
message Reading {
  string sensor_id = 1;
  double celsius = 2;
  int32 battery = 3;
  bool running = 4;
  repeated string tags = 5;
  Inner inner = 6;
  float ratio = 7;
  bytes blob = 8;
}
message Inner { int64 seq = 1; string note = 2; }`;

describe('decodeRaw', () => {
  it('reads a message nobody handed a schema for', () => {
    const bytes = encode(READING, 'acme.Reading', {
      sensor_id: 'lobby-1',
      celsius: 21.5,
      battery: 94,
      running: true,
      tags: ['a', 'b'],
      inner: { seq: 12, note: 'hi' },
      ratio: 0.5,
    });
    expect(decodeRaw(bytes)).toEqual({
      '1': 'lobby-1',
      '2': 21.5,
      '3': 94,
      '4': 1,
      '5': ['a', 'b'],
      '6': { '1': 12, '2': 'hi' },
      '7': 0.5,
    });
  });

  it('shows bytes that are neither a message nor text as hex', () => {
    const bytes = encode(READING, 'acme.Reading', { blob: new Uint8Array([0x00, 0x01, 0xfe, 0xff]) });
    expect(decodeRaw(bytes)).toEqual({ '8': '4 bytes · 00 01 fe ff' });
  });

  it('says nothing about bytes that are not protobuf at all', () => {
    expect(decodeRaw(new TextEncoder().encode('{"temp":21.5}'))).toBeNull();
    expect(decodeRaw(new Uint8Array([0xff, 0xff, 0xff]))).toBeNull();
    expect(decodeRaw(new Uint8Array())).toBeNull();
  });

  it('keeps a 64-bit field that is not a number as an integer', () => {
    // A fixed64 holding an id, not a measurement: the double reading of
    // those bytes is 5e-324-ish and no one would write that down.
    const bytes = new Uint8Array([0x09, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(decodeRaw(bytes)).toEqual({ '1': 1 });
  });

  it('keeps a big varint exact, where a number could not', () => {
    const bytes = encode('syntax = "proto3"; message M { uint64 id = 1; }', 'M', { id: '18446744073709551615' });
    expect(decodeRaw(bytes)).toEqual({ '1': '18446744073709551615' });
  });

  it('counts what it found, nested fields and all', () => {
    const msg = decodeRaw(encode(READING, 'acme.Reading', { sensor_id: 'a', inner: { seq: 1, note: 'x' }, tags: ['p', 'q'] }))!;
    // sensor_id, inner (+2 inside), two tags
    expect(countFields(msg)).toBe(6);
  });
});
