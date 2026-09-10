import { describe, expect, it } from 'vitest';
import { escapeTemplate, type ExportRow, flatten, serializeMessages } from './exportMessages';

const row = (over: Partial<ExportRow> = {}): ExportRow => ({
  timestamp: 1_700_000_000_000,
  subject: 'plant.line-1.robot',
  payload: JSON.stringify({ x: 400.9, unit: 'mm', nested: { ok: true } }),
  payloadType: 'json',
  size: 42,
  sequence: 7,
  ...over,
});

describe('NDJSON', () => {
  it('writes one message per line with the payload as a document', () => {
    const out = serializeMessages([row(), row({ sequence: 8 })], 'ndjson');
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    // A payload left as a string would make `jq .payload.x` and DuckDB's
    // read_json_auto() need a second parse, which is the whole point of it.
    expect(JSON.parse(lines[0]).payload).toEqual({ x: 400.9, unit: 'mm', nested: { ok: true } });
    expect(out.endsWith('\n')).toBe(true);
  });

  it('leaves a payload that is not JSON as text', () => {
    const line = serializeMessages([row({ payload: 'hello', payloadType: 'string' })], 'ndjson').trimEnd();
    expect(JSON.parse(line).payload).toBe('hello');
  });
});

describe('CSV', () => {
  it('keeps the headers it used to drop', () => {
    const out = serializeMessages([row({ headers: { 'Nats-Msg-Id': ['abc'] } })], 'csv');
    expect(out.split('\n')[0]).toContain('headers');
    expect(out).toContain('Nats-Msg-Id');
  });

  it('spreads a JSON payload into one column per field', () => {
    const out = serializeMessages([row({ headers: { 'Nats-Msg-Id': ['abc'] } })], 'csv-flat');
    const [head, first] = out.split('\n');
    expect(head.split(',')).toEqual([
      'time',
      'timestamp',
      'sequence',
      'subject',
      'payloadType',
      'size',
      'header.Nats-Msg-Id',
      'payload.nested.ok',
      'payload.unit',
      'payload.x',
    ]);
    expect(first).toContain('400.9');
    expect(first).toContain('abc');
  });

  it('gives every message every column, even the ones it lacks', () => {
    const out = serializeMessages([row(), row({ payload: JSON.stringify({ y: 1 }) })], 'csv-flat');
    const rows = out.trimEnd().split('\n');
    const columns = rows[0].split(',');
    expect(columns).toContain('payload.x');
    expect(columns).toContain('payload.y');
    // Both rows have as many cells as there are columns; a short row would
    // shift every later value into the wrong column.
    for (const r of rows.slice(1)) expect(r.split(',')).toHaveLength(columns.length);
  });

  it('puts a payload that is not JSON in a column of its own', () => {
    const out = serializeMessages([row({ payload: 'hello', payloadType: 'string' })], 'csv-flat');
    expect(out.split('\n')[0]).toContain('payload');
    expect(out).toContain('hello');
  });
});

describe('payloads only', () => {
  it('writes the bodies and nothing else', () => {
    const out = serializeMessages([row({ payload: 'a' }), row({ payload: 'b' })], 'payloads');
    expect(out).toBe('a\nb\n');
  });
});

describe('replay script', () => {
  it('quotes the subject, the payload and the headers for the shell', () => {
    const out = serializeMessages([row({ subject: "odd'subject", payload: `{"q":"it's"}`, headers: { 'X-A': ['1', '2'] } })], 'sh', 'plant');
    expect(out).toContain(`nats pub 'odd'\\''subject'`);
    expect(out).toContain(`'{"q":"it'\\''s"}'`);
    expect(out).toContain(`-H 'X-A:1' -H 'X-A:2'`);
    expect(out.startsWith('#!/bin/sh')).toBe(true);
  });

  it('escapes the template delimiter, because nats pub expands it', () => {
    // Measured against the real CLI: `nats pub s '{"t":"{{Count}}"}'`
    // publishes {"t":"1"}. There is no flag to turn templating off, and
    // stdin does not skip it either, so the body has to carry the escape.
    const out = serializeMessages([row({ payload: '{"t":"{{Count}}"}' })], 'sh');
    expect(out).toContain('{{"{{"}}Count}}');
    expect(out).not.toMatch(/'\{"t":"\{\{Count\}\}"\}'/);
  });

  it('sends a binary payload through base64 and stdin', () => {
    const out = serializeMessages([row({ payload: 'aGVsbG8=', payloadType: 'binary' })], 'sh');
    expect(out).toContain(`printf %s 'aGVsbG8=' | base64 -d | nats pub 'plant.line-1.robot' --force-stdin`);
    expect(out).toContain('1 binary payload goes through base64');
  });

  it('offers a delay between messages but does not impose one', () => {
    const out = serializeMessages([row(), row()], 'sh');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, checked verbatim
    expect(out).toContain('DELAY=${DELAY:-0}');
    expect(out).toContain('[ "$DELAY" = 0 ] || sleep "$DELAY"');
    // Only between messages, not after the last one.
    expect(out.match(/sleep "\$DELAY"/g)).toHaveLength(1);
  });
});

describe('escapeTemplate', () => {
  it('leaves a payload without a template alone', () => {
    expect(escapeTemplate('{"a":1}')).toBe('{"a":1}');
  });
  it('escapes every occurrence', () => {
    expect(escapeTemplate('{{a}} and {{b}}')).toBe('{{"{{"}}a}} and {{"{{"}}b}}');
  });
});

describe('flatten', () => {
  it('walks to the scalar leaves', () => {
    const out: Record<string, string> = {};
    flatten({ a: 1, b: { c: 'x' }, d: [10, 20] }, 'p', out);
    expect(out).toEqual({ 'p.a': '1', 'p.b.c': 'x', 'p.d.0': '10', 'p.d.1': '20' });
  });

  it('marks an empty container instead of dropping the column', () => {
    const out: Record<string, string> = {};
    flatten({ a: [], b: {}, c: null }, 'p', out);
    expect(out).toEqual({ 'p.a': '[]', 'p.b': '{}', 'p.c': '' });
  });

  it('stops spreading a deep document but keeps what is left', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 20; i++) deep = { d: deep };
    const out: Record<string, string> = {};
    flatten(deep, 'p', out);
    const keys = Object.keys(out);
    expect(keys).toHaveLength(1);
    expect(keys[0].split('.').length).toBeLessThanOrEqual(10);
    // The rest is a cell, not a hole: dropping it would lose data silently.
    expect(out[keys[0]]).toContain('bottom');
  });
});
