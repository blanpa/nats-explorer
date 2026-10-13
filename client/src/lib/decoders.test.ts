import { describe, expect, it } from 'vitest';
import { encode } from '@msgpack/msgpack';
import protobuf from 'protobufjs';
import avro from 'avsc';
import { type DecoderRule, decodeWith, encodeWith, findRule, messageTypesOf, subjectMatches } from './decoders';

const rule = (o: Partial<DecoderRule>): DecoderRule => ({ id: 'r', pattern: 'x', format: 'msgpack', ...o });

describe('subjectMatches', () => {
  it('follows NATS wildcard rules', () => {
    expect(subjectMatches('a.b', 'a.b')).toBe(true);
    expect(subjectMatches('a.*', 'a.b')).toBe(true);
    expect(subjectMatches('a.*', 'a.b.c')).toBe(false);
    expect(subjectMatches('a.>', 'a.b.c')).toBe(true);
    expect(subjectMatches('a.>', 'a')).toBe(false);
    expect(subjectMatches('>', 'anything.at.all')).toBe(true);
    expect(subjectMatches('a.b', 'a.c')).toBe(false);
  });
  it('picks the first matching rule', () => {
    const rules = [rule({ id: '1', pattern: 'telemetry.*' }), rule({ id: '2', pattern: 'telemetry.>' })];
    expect(findRule(rules, 'telemetry.plant.line')?.id).toBe('2');
    expect(findRule(rules, 'telemetry.plant')?.id).toBe('1');
    expect(findRule(rules, 'orders')).toBeUndefined();
    expect(findRule(rules, undefined)).toBeUndefined();
  });
});

describe('decodeWith', () => {
  it('decodes MessagePack', async () => {
    const res = await decodeWith(rule({ format: 'msgpack' }), encode({ temp: 21.5, ok: true }));
    expect(res).toEqual({ ok: true, value: { temp: 21.5, ok: true } });
  });

  it('decodes protobuf with a pasted .proto', async () => {
    const schema = 'syntax = "proto3"; package acme; message Reading { string sensor_id = 1; double value = 2; repeated int32 tags = 3; }';
    const Reading = protobuf.parse(schema, { keepCase: true }).root.lookupType('acme.Reading');
    const bytes = Reading.encode(Reading.create({ sensor_id: 's1', value: 3.5, tags: [1, 2] })).finish();
    const res = await decodeWith(rule({ format: 'protobuf', schema, messageType: 'acme.Reading' }), bytes);
    expect(res).toEqual({ ok: true, value: { sensor_id: 's1', value: 3.5, tags: [1, 2] } });
    // the first message type is the default
    const first = await decodeWith(rule({ format: 'protobuf', schema }), bytes);
    expect(first.ok && (first.value as { sensor_id: string }).sensor_id).toBe('s1');
  });

  it('decodes Avro with a schema', async () => {
    const schema = JSON.stringify({
      type: 'record',
      name: 'Reading',
      fields: [
        { name: 'sensor', type: 'string' },
        { name: 'value', type: 'double' },
      ],
    });
    const type = avro.Type.forSchema(JSON.parse(schema));
    const bytes = new Uint8Array(type.toBuffer({ sensor: 's1', value: 2.25 }));
    const res = await decodeWith(rule({ format: 'avro', schema }), bytes);
    expect(res).toEqual({ ok: true, value: { sensor: 's1', value: 2.25 } });
  });

  it('lists the message types a .proto defines, nested ones included', async () => {
    const schema = 'syntax = "proto3"; package acme; message Reading { string id = 1; message Inner { int32 n = 1; } } message Other { bool b = 1; }';
    expect(await messageTypesOf(schema)).toEqual(['acme.Reading', 'acme.Reading.Inner', 'acme.Other']);
    expect(await messageTypesOf('   ')).toEqual([]);
    await expect(messageTypesOf('this is not proto')).rejects.toThrow();
  });

  it('encodes with the same .proto it decodes with', async () => {
    const schema = 'syntax = "proto3"; message R { string id = 1; int32 n = 2; }';
    const bytes = await encodeWith(rule({ format: 'protobuf', schema, messageType: 'R' }), { id: 'a', n: 21 });
    expect([...bytes]).toEqual([0x0a, 0x01, 0x61, 0x10, 0x15]);
    expect(await decodeWith(rule({ format: 'protobuf', schema, messageType: 'R' }), bytes)).toEqual({ ok: true, value: { id: 'a', n: 21 } });
    // Only protobuf can be written; the others say so rather than guessing.
    await expect(encodeWith(rule({ format: 'msgpack' }), { a: 1 })).rejects.toThrow(/cannot be written/);
  });

  it('reports schema and payload problems instead of throwing', async () => {
    expect((await decodeWith(rule({ format: 'protobuf', schema: '' }), new Uint8Array())).ok).toBe(false);
    expect((await decodeWith(rule({ format: 'protobuf', schema: 'this is not proto' }), new Uint8Array())).ok).toBe(false);
    const bad = await decodeWith(rule({ format: 'msgpack' }), new Uint8Array([0xc1]));
    expect(bad.ok).toBe(false);
  });
});

describe('script decoders', () => {
  it('runs the body with the bytes and the helpers', async () => {
    const rule: DecoderRule = {
      id: 's',
      pattern: 'house.>',
      format: 'script',
      schema:
        'return { id: helpers.view.getUint16(0), value: helpers.view.getFloat32(2, true), unit: helpers.text(bytes.subarray(6)), hex: helpers.hex(bytes.subarray(0, 2)) };',
    };
    const bytes = new Uint8Array(9);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 258);
    view.setFloat32(2, 21.5, true);
    bytes.set(new TextEncoder().encode('°C'), 6);
    expect(await decodeWith(rule, bytes)).toEqual({ ok: true, value: { id: 258, value: 21.5, unit: '°C', hex: '0102' } });
  });

  it('reports a body that does not compile or throws, and refuses to write', async () => {
    const broken: DecoderRule = { id: 'b', pattern: 'x', format: 'script', schema: 'return {' };
    const res = await decodeWith(broken, new Uint8Array(1));
    expect(res.ok).toBe(false);
    const throwing: DecoderRule = { id: 't', pattern: 'x', format: 'script', schema: 'throw new Error("no")' };
    expect(await decodeWith(throwing, new Uint8Array(1))).toEqual({ ok: false, error: 'no' });
    await expect(encodeWith(throwing, {})).rejects.toThrow(/cannot be written/);
  });
});
