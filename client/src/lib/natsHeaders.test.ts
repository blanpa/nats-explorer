import { describe, expect, it } from 'vitest';
import { describeHeader, isNatsHeader, msgId, repeatedIds } from './natsHeaders';

describe('describeHeader', () => {
  it('explains the headers NATS sets', () => {
    expect(describeHeader('Nats-Msg-Id')).toContain('duplicate window');
    expect(describeHeader('Nats-Expected-Last-Subject-Sequence')).toContain('compare-and-set');
  });

  it('reads the value where the value is a term', () => {
    // "sub" and "all" are the two rollups, and they do different things.
    expect(describeHeader('Nats-Rollup', ['sub'])).toContain('on this subject');
    expect(describeHeader('Nats-Rollup', ['all'])).toContain('whole stream');
    expect(describeHeader('Nats-Rollup', ['?'])).toBe('This message replaces what came before it.');
  });

  it('says nothing about a publisher’s own header', () => {
    expect(describeHeader('X-Trace-Id')).toBeUndefined();
    expect(isNatsHeader('X-Trace-Id')).toBe(false);
    expect(isNatsHeader('nats-msg-id')).toBe(true);
  });
});

describe('msgId', () => {
  it('finds the deduplication id whatever the case', () => {
    expect(msgId({ 'nats-msg-id': ['a1'] })).toBe('a1');
    expect(msgId({ 'Nats-Msg-Id': ['a1'] })).toBe('a1');
    expect(msgId({ other: ['x'] })).toBeUndefined();
    expect(msgId(undefined)).toBeUndefined();
  });
});

describe('repeatedIds', () => {
  it('names the ids that occur more than once', () => {
    const twice = repeatedIds([
      { headers: { 'Nats-Msg-Id': ['a'] } },
      { headers: { 'Nats-Msg-Id': ['b'] } },
      { headers: { 'Nats-Msg-Id': ['a'] } },
      { headers: {} },
      {},
    ]);
    expect([...twice]).toEqual(['a']);
  });

  it('is empty when every message carries its own id', () => {
    expect(repeatedIds([{ headers: { 'Nats-Msg-Id': ['a'] } }, { headers: { 'Nats-Msg-Id': ['b'] } }]).size).toBe(0);
  });
});
