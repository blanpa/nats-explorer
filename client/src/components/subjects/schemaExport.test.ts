import { describe, expect, it } from 'vitest';
import type { SchemaField, SubjectSchema } from '../../lib/api.schema';
import { pathSteps, toJsonSchema, toTypeScript, typeName } from './schemaExport';

const field = (path: string, type: string, presence = 1, over: Partial<SchemaField> = {}): SchemaField => ({
  path,
  types: [{ type, count: 10 }],
  presence,
  example: '',
  ...over,
});

const schemaOf = (fields: SchemaField[]): SubjectSchema => ({
  samples: 10,
  kinds: { json: 10 },
  fields,
  drift: [],
  from: 0,
  to: 0,
});

/** The nested payload used by most cases below. */
const nested = schemaOf([
  field('v', 'number', 1, { min: 10.5, max: 89.9, example: '62.7' }),
  field('unit', 'string', 1, { example: '"C"', enum: ['C', 'F'] }),
  field('note', 'string', 0.4, { example: '"calibrated"' }),
  field('meta', 'object'),
  field('meta.id', 'string', 1, { example: '"m-1"' }),
  field('tags', 'array'),
  field('tags[]', 'string', 1, { example: '"hot"' }),
]);

describe('pathSteps', () => {
  it('splits members and array steps', () => {
    expect(pathSteps('v')).toEqual(['v']);
    expect(pathSteps('meta.id')).toEqual(['meta', 'id']);
    expect(pathSteps('tags[]')).toEqual(['tags', '[]']);
    expect(pathSteps('rows[].cells[].n')).toEqual(['rows', '[]', 'cells', '[]', 'n']);
  });
});

describe('typeName', () => {
  it('makes a type name out of a subject', () => {
    expect(typeName('factory.line1.machine1.temp')).toBe('FactoryLine1Machine1Temp');
    expect(typeName('1st.thing')).toBe('Subject1stThing');
    expect(typeName('...')).toBe('Payload');
  });
});

describe('toJsonSchema', () => {
  const doc = JSON.parse(toJsonSchema('factory.temp', nested));

  it('rebuilds the object tree from the flat paths', () => {
    expect(doc.type).toBe('object');
    expect(doc.properties.v.type).toBe('number');
    expect(doc.properties.meta.type).toBe('object');
    expect(doc.properties.meta.properties.id.type).toBe('string');
    expect(doc.properties.tags.type).toBe('array');
    expect(doc.properties.tags.items.type).toBe('string');
  });

  it('marks only the fields that every message carried as required', () => {
    expect(doc.required).toEqual(['v', 'unit', 'meta', 'tags']);
    expect(doc.required).not.toContain('note');
  });

  it('is honest about being derived from samples', () => {
    expect(doc.$schema).toContain('json-schema.org');
    expect(doc.description).toMatch(/Derived .* from 10 JSON messages on factory\.temp/);
    expect(doc.description).toMatch(/not from a contract/);
    // Observed values are context, not constraints: a range must not become
    // a rule that rejects a legitimately larger value.
    expect(doc.properties.v.minimum).toBeUndefined();
    expect(doc.properties.v.description).toBe('observed range 10.5 … 89.9');
    // A field that is always there and says nothing else needs no note.
    expect(doc.properties.meta.properties.id.description).toBeUndefined();
    expect(doc.properties.note.description).toBe('seen in 40% of the sampled messages');
    expect(doc.additionalProperties).toBe(true);
    expect(doc.properties.v.examples).toEqual([62.7]);
  });

  it('closes an enumeration only when the field is nothing but a string', () => {
    expect(doc.properties.unit.enum).toEqual(['C', 'F']);
    const mixed = JSON.parse(
      toJsonSchema(
        's',
        schemaOf([
          {
            ...field('code', 'string'),
            types: [
              { type: 'string', count: 8 },
              { type: 'integer', count: 2 },
            ],
            enum: ['a', 'b'],
          },
        ]),
      ),
    );
    expect(mixed.properties.code.enum).toBeUndefined();
    expect(mixed.properties.code.type).toEqual(['string', 'integer']);
    expect(mixed.properties.code.description).toContain('observed strings: a, b');
  });

  it('adds null to the type instead of dropping it', () => {
    const doc = JSON.parse(
      toJsonSchema(
        's',
        schemaOf([
          {
            ...field('v', 'number'),
            types: [
              { type: 'number', count: 9 },
              { type: 'null', count: 1 },
            ],
          },
        ]),
      ),
    );
    expect(doc.properties.v.type).toEqual(['number', 'null']);
  });
});

describe('toTypeScript', () => {
  it('writes an interface with optional fields, nesting and arrays', () => {
    const ts = toTypeScript('factory.temp', nested);
    expect(ts).toContain('export interface FactoryTemp {');
    expect(ts).toContain('v: number;');
    expect(ts).toContain("unit: 'C' | 'F';".replace(/'/g, '"'));
    expect(ts).toContain('note?: string;');
    expect(ts).toContain('tags: string[];');
    expect(ts).toMatch(/meta: \{\n(.*\n)*? {2}\};/);
    expect(ts).toContain('id: string;');
    // The header says where it came from.
    expect(ts).toContain('Derived by NATS Explorer');
  });

  it('quotes keys that are not identifiers and unions mixed types', () => {
    const ts = toTypeScript(
      's',
      schemaOf([
        {
          ...field('content-type', 'string'),
          types: [
            { type: 'string', count: 5 },
            { type: 'integer', count: 5 },
          ],
        },
      ]),
    );
    expect(ts).toContain('"content-type": string | number;');
  });

  it('parenthesises a union inside an array', () => {
    const ts = toTypeScript(
      's',
      schemaOf([
        field('xs', 'array'),
        {
          ...field('xs[]', 'string'),
          types: [
            { type: 'string', count: 5 },
            { type: 'integer', count: 5 },
          ],
        },
      ]),
    );
    expect(ts).toContain('xs: (string | number)[];');
  });

  it('falls back to an open record when nothing was derived', () => {
    expect(toTypeScript('s', schemaOf([]))).toContain('[key: string]: unknown;');
  });

  it('writes a type alias for a payload that is an array at the top level', () => {
    const top = schemaOf([field('[]', 'object'), field('[].n', 'integer')]);
    const ts = toTypeScript('s', top);
    expect(ts).toContain('export type S = {');
    expect(ts).toContain('  n: number;');
    expect(ts).toContain('}[];');
    expect(JSON.parse(toJsonSchema('s', top)).type).toBe('array');
  });
});
