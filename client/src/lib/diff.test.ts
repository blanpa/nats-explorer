import { describe, expect, it } from 'vitest';
import { diffLines } from './diff';

describe('diffLines', () => {
  it('reports identical input as unchanged', () => {
    const ops = diffLines('a\nb', 'a\nb');
    expect(ops.every(o => o.type === 'same')).toBe(true);
    expect(ops).toHaveLength(2);
  });

  it('finds an inserted line without marking the rest as changed', () => {
    const ops = diffLines('a\nc', 'a\nb\nc');
    expect(ops).toEqual([
      { type: 'same', line: 'a' },
      { type: 'add', line: 'b' },
      { type: 'same', line: 'c' },
    ]);
  });

  it('finds a removed line', () => {
    const ops = diffLines('a\nb\nc', 'a\nc');
    expect(ops.filter(o => o.type === 'del')).toEqual([{ type: 'del', line: 'b' }]);
    expect(ops.filter(o => o.type === 'add')).toHaveLength(0);
  });

  it('treats a changed value as delete + add', () => {
    const ops = diffLines('{\n  "v": 1\n}', '{\n  "v": 2\n}');
    expect(ops.map(o => o.type)).toEqual(['same', 'del', 'add', 'same']);
  });

  it('falls back to positional diff for huge inputs', () => {
    const big = Array.from({ length: 700 }, (_, i) => `line ${i}`).join('\n');
    const ops = diffLines(big, big.replace('line 5\n', 'line X\n'));
    expect(ops.filter(o => o.type !== 'same')).toEqual([
      { type: 'del', line: 'line 5' },
      { type: 'add', line: 'line X' },
    ]);
  });
});
