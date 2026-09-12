import { describe, expect, it } from 'vitest';
import type { NatsMessage } from 'shared';
import { columnsOf, fieldsOf, stateCsv, stateRows } from './stateTable';

const msg = (subject: string, t: number, payload: unknown): NatsMessage => ({
  subject,
  payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  payloadType: typeof payload === 'string' ? 'string' : 'json',
  timestamp: t,
  size: 1,
});

describe('stateRows', () => {
  it('keeps the newest message of every subject', () => {
    const rows = stateRows([msg('plant.b', 2000, { v: 2 }), msg('plant.a', 1000, { v: 1 }), msg('plant.a', 3000, { v: 9 })]);
    expect(rows.map(r => r.subject)).toEqual(['plant.a', 'plant.b']);
    expect(rows[0].fields.v).toBe('9');
    expect(rows[0].at).toBe(3000);
  });
});

describe('fieldsOf', () => {
  it('takes the scalars and leaves the nesting to the payload viewer', () => {
    expect(fieldsOf(msg('s', 1, { celsius: 21.5, ok: true, note: null, meta: { a: 1 }, tags: [1] }))).toEqual({
      celsius: '21.5',
      ok: 'true',
      note: 'null',
    });
    expect(fieldsOf(msg('s', 1, 'plain text'))).toEqual({});
  });
});

describe('columnsOf', () => {
  it('offers the fields most rows carry, commonest first', () => {
    const rows = stateRows([msg('a', 1, { v: 1, unit: 'C' }), msg('b', 1, { v: 2 }), msg('c', 1, { v: 3, rare: 1 })]);
    expect(columnsOf(rows)).toEqual(['v', 'rare', 'unit']);
    expect(columnsOf(rows, 1)).toEqual(['v']);
  });
});

describe('stateCsv', () => {
  it('writes what is on screen, quoting what needs it', () => {
    const rows = stateRows([msg('a', 1000, { v: 1, note: 'a,b' })]);
    const csv = stateCsv(rows, ['v', 'note'], 4000);
    expect(csv.split('\n')[0]).toBe('subject,v,note,age_seconds,at');
    expect(csv.split('\n')[1]).toContain('a,1,"a,b",3,');
  });
});
