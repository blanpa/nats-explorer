// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { type DecoderRule, newRule } from './decoders';
import { isBinaryFormat, markupOf, parseBase64, parseHex, payloadProblem, prettyPayload, prettyXml, toWire, wireLength } from './payloadFormat';

const bytes = (...n: number[]) => new Uint8Array(n);

describe('parseHex', () => {
  it('reads hex the way people write it', () => {
    expect(parseHex('deadbeef')).toEqual(bytes(0xde, 0xad, 0xbe, 0xef));
    expect(parseHex('DE AD BE EF')).toEqual(bytes(0xde, 0xad, 0xbe, 0xef));
    expect(parseHex('0xde:0xad')).toEqual(bytes(0xde, 0xad));
    expect(parseHex('de\nad')).toEqual(bytes(0xde, 0xad));
    expect(parseHex('')).toEqual(bytes());
  });
  it('refuses half a byte and anything that is not hex', () => {
    expect(parseHex('abc')).toBeNull();
    expect(parseHex('zz')).toBeNull();
  });
});

describe('parseBase64', () => {
  it('ignores the line breaks of a pasted block', () => {
    expect(parseBase64('aGk=')).toEqual(bytes(104, 105));
    expect(parseBase64('aG\nkh')).toEqual(bytes(104, 105, 33));
  });
  it('refuses what is not base64', () => {
    expect(parseBase64('not base64!')).toBeNull();
  });
});

describe('wireLength', () => {
  it('counts the bytes that will travel, not the characters typed', () => {
    expect(wireLength('hex', 'de ad be ef')).toBe(4);
    expect(wireLength('base64', 'aGk=')).toBe(2);
    expect(wireLength('text', 'grüße')).toBe(7);
    expect(wireLength('json', '{"a":1}')).toBe(7);
  });
  it('says nothing where it cannot know', () => {
    expect(wireLength('hex', 'abc')).toBeNull();
    // Protobuf needs the schema to answer, and guessing would be worse.
    expect(wireLength('protobuf', '{"a":1}')).toBeNull();
  });
});

describe('payloadProblem', () => {
  it('keeps quiet about an empty editor and about text', () => {
    expect(payloadProblem('json', '   ')).toBeNull();
    expect(payloadProblem('text', 'anything at all')).toBeNull();
    expect(payloadProblem('html', '<p>unclosed')).toBeNull();
  });
  it('reads a placeholder as the value it will become', () => {
    // `{"n": {{i}}}` is not JSON until the run puts a number there, and
    // warning about it on every templated payload is noise.
    expect(payloadProblem('json', '{"id": "{{uuid}}", "n": {{i}}}')).toBeNull();
    expect(payloadProblem('json', '{"n": {{rand:1-9}}, "broken": }')).toContain('Not JSON');
  });

  it('names what is wrong per format', () => {
    expect(payloadProblem('json', '{oops')).toContain('Not JSON');
    expect(payloadProblem('hex', 'abc')).toContain('Not hex');
    expect(payloadProblem('base64', '!!')).toContain('Not base64');
    expect(payloadProblem('xml', '<a><b></a>')).toContain('Not well-formed XML');
    expect(payloadProblem('xml', '<a><b/></a>')).toBeNull();
  });
});

describe('prettyPayload', () => {
  it('indents JSON and XML, groups hex, and leaves text alone', () => {
    expect(prettyPayload('json', '{"a":1}')).toBe('{\n  "a": 1\n}\n');
    expect(prettyXml('<a><b>1</b></a>')).toBe('<a>\n  <b>1</b>\n</a>');
    expect(prettyPayload('hex', 'DEADBEEF')).toBe('de ad be ef');
    expect(prettyPayload('text', 'x')).toBeNull();
    expect(prettyPayload('html', '<ul><li>a</li><li>b</li></ul>')).toBe('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>');
  });
  it('has nothing to tidy in what does not parse', () => {
    expect(prettyPayload('json', '{oops')).toBeNull();
    expect(prettyPayload('hex', 'abc')).toBeNull();
  });
});

describe('markupOf', () => {
  it('tells the two markups apart by their first tag', () => {
    expect(markupOf('<?xml version="1.0"?><a/>')).toBe('xml');
    expect(markupOf('<!DOCTYPE html><html></html>')).toBe('html');
    expect(markupOf('<div class="x">hi</div>')).toBe('html');
    expect(markupOf('<reading><celsius>21</celsius></reading>')).toBe('xml');
    expect(markupOf('{"a":1}')).toBeNull();
    expect(markupOf('  not markup')).toBeNull();
  });
});

describe('prettyXml', () => {
  it('does not indent behind a tag that never closes', () => {
    // <br> and friends have no closing tag; treating them as open drifts
    // every line below them one level to the right.
    expect(prettyXml('<p>a<br><span>b</span></p>')).toContain('  <span>b</span>');
  });
});

describe('toWire', () => {
  const noRules: DecoderRule[] = [];

  it('sends text formats as they stand, broken or not', async () => {
    expect(await toWire('text', 'hello', 's', noRules)).toEqual({ payload: 'hello' });
    // A payload that does not parse is still the payload someone wants to
    // reproduce; it travels as it is.
    expect(await toWire('json', '{oops', 's', noRules)).toEqual({ payload: '{oops' });
    expect(await toWire('html', '<p>hi', 's', noRules)).toEqual({ payload: '<p>hi' });
  });

  it('turns the byte formats into base64 for the wire', async () => {
    expect(await toWire('hex', '68 69', 's', noRules)).toEqual({ payload: 'aGk=', payloadType: 'binary' });
    expect(await toWire('base64', 'aG kh', 's', noRules)).toEqual({ payload: 'aGkh', payloadType: 'binary' });
    expect(isBinaryFormat('hex')).toBe(true);
    expect(isBinaryFormat('json')).toBe(false);
  });

  it('refuses to send half a byte', async () => {
    await expect(toWire('hex', 'abc', 's', noRules)).rejects.toThrow(/hex/);
  });

  it('encodes protobuf with the decoder that matches the subject', async () => {
    const rule = newRule({
      pattern: 'plant.>',
      format: 'protobuf',
      messageType: 'acme.Reading',
      schema: 'syntax = "proto3"; package acme; message Reading { string id = 1; int32 celsius = 2; }',
    });
    const wire = await toWire('protobuf', '{"id":"a","celsius":21}', 'plant.line1', [rule]);
    expect(wire.payloadType).toBe('binary');
    // field 1 "a", field 2 varint 21
    expect([...parseBase64(wire.payload)!]).toEqual([0x0a, 0x01, 0x61, 0x10, 0x15]);
  });

  it('says which schema is missing instead of sending something else', async () => {
    await expect(toWire('protobuf', '{}', 'plant.line1', noRules)).rejects.toThrow(/no payload decoder matches/);
    const msgpack = newRule({ pattern: 'plant.>', format: 'msgpack' });
    await expect(toWire('protobuf', '{}', 'plant.line1', [msgpack])).rejects.toThrow(/is msgpack, not protobuf/);
    const rule = newRule({
      pattern: 'plant.>',
      format: 'protobuf',
      messageType: 'acme.Reading',
      schema: 'syntax = "proto3"; package acme; message Reading { string id = 1; }',
    });
    await expect(toWire('protobuf', 'not json', 'plant.line1', [rule])).rejects.toThrow(/not JSON/i);
  });
});
