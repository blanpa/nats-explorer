import { describe, expect, it } from 'vitest';
import { subjectMatches } from './subjectMatch';

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
