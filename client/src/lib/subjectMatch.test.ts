import { describe, expect, it } from 'vitest';
import { covers, overlappingPatterns, subjectMatches } from './subjectMatch';

/**
 * The same cases the server's matcher is held to. Where these two drift, the
 * explorer says a subscription covers a subject and the server disagrees,
 * which is worse than not answering at all.
 */
describe('subjectMatches', () => {
  it('matches a subject against itself', () => {
    expect(subjectMatches('orders.eu.created', 'orders.eu.created')).toBe(true);
    expect(subjectMatches('orders.eu.created', 'orders.us.created')).toBe(false);
  });

  it('* is exactly one token, never across a dot', () => {
    expect(subjectMatches('orders.*.created', 'orders.eu.created')).toBe(true);
    expect(subjectMatches('orders.*', 'orders.eu.created')).toBe(false);
    expect(subjectMatches('orders.*', 'orders')).toBe(false);
  });

  it('> takes the rest, and at least one token of it', () => {
    expect(subjectMatches('orders.>', 'orders.eu.created')).toBe(true);
    expect(subjectMatches('orders.>', 'orders.eu')).toBe(true);
    // Not the bare parent: > needs something to cover.
    expect(subjectMatches('orders.>', 'orders')).toBe(false);
    expect(subjectMatches('>', 'orders.eu.created')).toBe(true);
  });

  it('> only counts as the last token', () => {
    expect(subjectMatches('orders.>.created', 'orders.eu.created')).toBe(false);
  });

  it('the two wildcards combine', () => {
    expect(subjectMatches('*.eu.>', 'orders.eu.created.v2')).toBe(true);
    expect(subjectMatches('*.eu.>', 'orders.us.created')).toBe(false);
  });

  it('says no rather than throwing on nothing', () => {
    expect(subjectMatches('', 'orders')).toBe(false);
    expect(subjectMatches('orders.>', '')).toBe(false);
  });
});

describe('covers', () => {
  it('sees when one subscription makes another one dead weight', () => {
    expect(covers('uns.>', 'uns.acme.>')).toBe(true);
    expect(covers('uns.>', 'uns.acme.line1.temp')).toBe(true);
    expect(covers('>', 'anything.at.all')).toBe(true);
    expect(covers('uns.*.temp', 'uns.acme.temp')).toBe(true);
    expect(covers('uns.acme.>', 'uns.>')).toBe(false);
    expect(covers('uns.acme.temp', 'uns.acme.humidity')).toBe(false);
    expect(covers('uns.*.temp', 'uns.acme.humidity')).toBe(false);
    // A wildcard cannot be covered by a concrete token.
    expect(covers('uns.acme.temp', 'uns.*.temp')).toBe(false);
  });
});

describe('overlappingPatterns', () => {
  it('names the pattern that adds nothing', () => {
    expect(overlappingPatterns(['uns.>', 'uns.acme.>', 'orders.>'])).toEqual([{ wide: 'uns.>', narrow: 'uns.acme.>' }]);
    expect(overlappingPatterns(['uns.>', 'orders.>'])).toEqual([]);
  });
});
