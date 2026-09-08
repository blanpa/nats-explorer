import { describe, expect, it } from 'vitest';
import { encode } from '@msgpack/msgpack';
import protobuf from 'protobufjs';
import avro from 'avsc';
import { type DecoderRule, decodeWith, findRule, subjectMatches } from './decoders';

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

  it('reports schema and payload problems instead of throwing', async () => {
    expect((await decodeWith(rule({ format: 'protobuf', schema: '' }), new Uint8Array())).ok).toBe(false);
    expect((await decodeWith(rule({ format: 'protobuf', schema: 'this is not proto' }), new Uint8Array())).ok).toBe(false);
    const bad = await decodeWith(rule({ format: 'msgpack' }), new Uint8Array([0xc1]));
    expect(bad.ok).toBe(false);
  });
});
