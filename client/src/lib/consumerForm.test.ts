import { describe, expect, it } from 'vitest';
import { formatBackoff, parseBackoff, splitFilters } from './consumerForm';

describe('backoff', () => {
  it('reads seconds per attempt and skips what is not one', () => {
    expect(parseBackoff('1, 5, 30')).toEqual([1e9, 5e9, 30e9]);
    expect(parseBackoff('0.5 x -1')).toEqual([5e8]);
    expect(parseBackoff('')).toEqual([]);
  });

  it('round-trips', () => {
    expect(formatBackoff([1e9, 5e9, 30e9])).toBe('1, 5, 30');
    expect(parseBackoff(formatBackoff([1e9, 2.5e9]))).toEqual([1e9, 2.5e9]);
    expect(formatBackoff(undefined)).toBe('');
  });
});

describe('splitFilters', () => {
  it('keeps one filter on the single field and several on the list', () => {
    expect(splitFilters('')).toEqual({});
    expect(splitFilters(' orders.> ')).toEqual({ filterSubject: 'orders.>' });
    expect(splitFilters('orders.eu.>, orders.us.>')).toEqual({ filterSubjects: ['orders.eu.>', 'orders.us.>'] });
  });
});
