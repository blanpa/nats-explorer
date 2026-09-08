import { describe, expect, it } from 'vitest';
import type { SchemaDrift, SchemaField, SubjectSchema } from '../../lib/api.schema';
import { describeDrift, describeKinds, driftByPath, formatPresence, formatRange, isOptional, orphanDrift, typeTone } from './schema';

const field = (over: Partial<SchemaField> = {}): SchemaField => ({
  path: 'temp',
  types: [{ type: 'number', count: 3 }],
  presence: 1,
  example: '21.5',
  ...over,
});

const schema = (over: Partial<SubjectSchema> = {}): SubjectSchema => ({
  samples: 10,
  kinds: { json: 10 },
  fields: [field()],
  drift: [],
  from: 1,
  to: 2,
  ...over,
});

describe('formatPresence', () => {
  it('reads as a whole percentage unless it is small', () => {
    expect(formatPresence(1)).toBe('100%');
    expect(formatPresence(0.9999)).toBe('100%');
    expect(formatPresence(0.5)).toBe('50%');
    expect(formatPresence(0.333)).toBe('33%');
    expect(formatPresence(0.05)).toBe('5.0%');
    expect(formatPresence(0.0005)).toBe('<0.1%');
    expect(formatPresence(0)).toBe('0%');
  });
});

describe('isOptional', () => {
  it('is true only when messages are missing the field', () => {
    expect(isOptional(field({ presence: 1 }))).toBe(false);
    expect(isOptional(field({ presence: 0.8 }))).toBe(true);
  });
});

describe('formatRange', () => {
  it('prefers the enumeration, then the range, and trims noise', () => {
    expect(formatRange(field({ enum: ['idle', 'run'] }))).toBe('idle | run');
    expect(formatRange(field({ min: 19.25, max: 22 }))).toBe('19.25 … 22');
    expect(formatRange(field({ min: 5, max: 5 }))).toBe('5');
    expect(formatRange(field({ min: 0.1000000001, max: 1 }))).toBe('0.1 … 1');
    expect(formatRange(field())).toBe('');
  });
});

describe('describeDrift', () => {
  it('says what changed', () => {
    const d = (over: Partial<SchemaDrift>): SchemaDrift => ({ path: 'p', kind: 'type-changed', before: 'integer', after: 'string', since: 1, ...over });
    expect(describeDrift(d({}))).toBe('type changed from integer to string');
    expect(describeDrift(d({ kind: 'field-gone', after: '' }))).toBe('no longer sent (was integer)');
    expect(describeDrift(d({ kind: 'field-new', before: '', after: 'bool' }))).toBe('new field (bool)');
  });
});

describe('typeTone', () => {
  it('separates numbers, text and structure', () => {
    expect(typeTone('number')).toBe('info');
    expect(typeTone('integer')).toBe('info');
    expect(typeTone('string')).toBe('accent');
    expect(typeTone('bool')).toBe('ok');
    expect(typeTone('null')).toBe('warn');
    expect(typeTone('object')).toBe('neutral');
  });
});

describe('driftByPath', () => {
  it('keeps the first entry per path', () => {
    const a: SchemaDrift = { path: 'x', kind: 'type-changed', before: 'a', after: 'b', since: 1 };
    const b: SchemaDrift = { path: 'x', kind: 'field-new', before: '', after: 'c', since: 2 };
    const map = driftByPath([a, b]);
    expect(map.size).toBe(1);
    expect(map.get('x')).toBe(a);
  });
});

describe('describeKinds', () => {
  it('lists JSON first and skips empty kinds', () => {
    expect(describeKinds(schema({ kinds: { binary: 1, json: 4, string: 2 } }))).toBe('4 json · 2 string · 1 binary');
    expect(describeKinds(schema({ kinds: { json: 3, string: 0 } }))).toBe('3 json');
  });
});

describe('orphanDrift', () => {
  it('returns only drift for paths that have no field row left', () => {
    const gone: SchemaDrift = { path: 'old', kind: 'field-gone', before: 'integer', after: '', since: 5 };
    const known: SchemaDrift = { path: 'temp', kind: 'type-changed', before: 'integer', after: 'string', since: 5 };
    expect(orphanDrift(schema({ drift: [gone, known] }))).toEqual([gone]);
  });
});
