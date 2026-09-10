import { describe, expect, it } from 'vitest';
import { extractNumber, formatBytes, formatDurationNs, formatNumber, formatUptime, hexDump, parseList, payloadBytes, previewPayload } from './utils';

describe('formatting', () => {
  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(-1)).toBe('unlimited');
    expect(formatBytes(undefined)).toBe('–');
  });

  it('formatNumber', () => {
    expect(formatNumber(999)).toBe('999');
    expect(formatNumber(12_345)).toBe('12.3K');
    expect(formatNumber(2_500_000)).toBe('2.5M');
    expect(formatNumber(-1)).toBe('unlimited');
  });

  it('formatDurationNs', () => {
    expect(formatDurationNs(0)).toBe('unlimited');
    expect(formatDurationNs(2 * 60 * 1e9)).toBe('2m');
    expect(formatDurationNs(30 * 24 * 3600 * 1e9)).toBe('30d');
  });
});

describe('payload helpers', () => {
  it('decodes base64 binary payloads and encodes text as UTF-8', () => {
    expect(Array.from(payloadBytes('//4A', 'binary'))).toEqual([0xff, 0xfe, 0x00]);
    expect(Array.from(payloadBytes('é', 'string'))).toEqual([0xc3, 0xa9]);
  });

  it('renders a hex dump with offsets and ascii column', () => {
    const dump = hexDump(new Uint8Array([0x48, 0x69, 0x00, 0xff]));
    expect(dump).toBe('00000000  48 69 00 ff                                       |Hi..|');
  });

  it('previewPayload picks the right tone', () => {
    expect(previewPayload('42', 'json')).toEqual({ text: '42', tone: 'num' });
    expect(previewPayload('true', 'json')).toEqual({ text: 'true', tone: 'bool' });
    expect(previewPayload('null', 'json')).toEqual({ text: 'null', tone: 'null' });
    expect(previewPayload('{"a":1}', 'json')).toEqual({ text: '{"a":1}', tone: 'obj' });
    expect(previewPayload('hello   world', 'string')).toEqual({ text: 'hello world', tone: 'str' });
    expect(previewPayload('AAAA', 'binary').tone).toBe('bin');
    expect(previewPayload('x'.repeat(100), 'string', 10).text).toHaveLength(11);
  });

  it('extractNumber follows dotted paths incl. array indexes', () => {
    const p = JSON.stringify({ a: { b: [1, { c: 2.5 }] }, s: '3' });
    expect(extractNumber(p, 'a.b.0')).toBe(1);
    expect(extractNumber(p, 'a.b.1.c')).toBe(2.5);
    expect(extractNumber(p, 's')).toBeNull();
    expect(extractNumber(p, 'missing.path')).toBeNull();
    expect(extractNumber('not json', 'a')).toBeNull();
  });

  it('parseList splits on commas and newlines', () => {
    expect(parseList(' a, b\n\nc ,')).toEqual(['a', 'b', 'c']);
  });
});

describe('formatUptime', () => {
  it('reads like an uptime: two units at most', () => {
    expect(formatUptime(47_000)).toBe('47s');
    expect(formatUptime(14 * 60_000)).toBe('14m');
    expect(formatUptime(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14m');
    expect(formatUptime(5 * 86_400_000 + 3 * 3_600_000)).toBe('5d 3h');
  });

  it('drops a unit that is zero rather than writing it out', () => {
    expect(formatUptime(3 * 3_600_000)).toBe('3h');
    expect(formatUptime(2 * 86_400_000)).toBe('2d');
  });

  it('says nothing rather than a negative age', () => {
    // A clock that disagrees with the server's is not an uptime.
    expect(formatUptime(-1000)).toBe('–');
    expect(formatUptime(Number.NaN)).toBe('–');
  });
});
