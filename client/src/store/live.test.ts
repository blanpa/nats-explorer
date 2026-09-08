import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NatsMessage } from 'shared';

// The store reads the theme and a few settings from the DOM when it is created.
vi.hoisted(() => {
  Object.assign(globalThis, {
    document: { documentElement: { dataset: {} } },
    window: { matchMedia: () => ({ matches: false }) },
  });
});

import { MAX_BRANCH_MESSAGES, MAX_SUBJECT_MESSAGES, useStore } from './index';

const msg = (subject: string, sequence: number, connId = 'c1'): NatsMessage => ({
  subject,
  payload: `${sequence}`,
  payloadType: 'string',
  timestamp: 1000 + sequence,
  size: 1,
  sequence,
  connId,
});

describe('live view', () => {
  beforeEach(() => {
    useStore.getState().setSelectedSubject(null);
    useStore.getState().setSelectedSubject('a.b');
  });

  const view = (subject = 'a.b') => useStore.getState().live.get(subject)!;

  it('selecting a subject starts an empty, loading view', () => {
    expect(view()).toMatchObject({ subject: 'a.b', messages: [], branch: [], loading: true, error: null });
    expect(useStore.getState().selectedSubjects).toEqual(['a.b']);
  });

  it('feed messages are sorted into exact and branch buffers, everything else is ignored', () => {
    useStore.getState().ingestFeed([msg('a.b', 1), msg('a.b.x', 2), msg('a.bc', 3), msg('a.b.y', 4), msg('a.b', 5)]);
    expect(view().messages.map(m => m.sequence)).toEqual([1, 5]);
    expect(view().branch.map(m => m.sequence)).toEqual([4, 2]); // newest first
  });

  it('history merges with what the feed delivered meanwhile, without duplicates', () => {
    useStore.getState().ingestFeed([msg('a.b', 3), msg('a.b', 4), msg('a.b.x', 5)]);
    useStore.getState().applyHistory('a.b', { subject: 'a.b', messages: [msg('a.b', 1), msg('a.b', 2), msg('a.b', 3)], branch: [msg('a.b.x', 5)] });
    expect(view().loading).toBe(false);
    expect(view().messages.map(m => m.sequence)).toEqual([1, 2, 3, 4]);
    expect(view().branch.map(m => m.sequence)).toEqual([5]);
  });

  it('history for a subject that is no longer selected is dropped', () => {
    useStore.getState().applyHistory('other', { subject: 'other', messages: [msg('other', 1)], branch: [] });
    expect(useStore.getState().live.has('other')).toBe(false);
    expect(view().loading).toBe(true);
  });

  it('several subjects are watched at once, each with its own view', () => {
    const s = useStore.getState();
    s.toggleSelectedSubject('c.d');
    expect(useStore.getState().selectedSubjects).toEqual(['a.b', 'c.d']);
    expect(useStore.getState().selectedSubject).toBe('c.d');
    useStore.getState().ingestFeed([msg('a.b', 1), msg('c.d', 2), msg('c.d.deep', 3)]);
    expect(view('a.b').messages.map(m => m.sequence)).toEqual([1]);
    expect(view('c.d').messages.map(m => m.sequence)).toEqual([2]);
    expect(view('c.d').branch.map(m => m.sequence)).toEqual([3]);
    // Untouched views keep their identity so their subscribers do not re-render.
    const before = view('a.b');
    useStore.getState().ingestFeed([msg('c.d', 4)]);
    expect(view('a.b')).toBe(before);
    useStore.getState().toggleSelectedSubject('a.b');
    expect(useStore.getState().selectedSubjects).toEqual(['c.d']);
    expect(useStore.getState().live.has('a.b')).toBe(false);
    useStore.getState().setSelectedSubject('x');
    expect(useStore.getState().selectedSubjects).toEqual(['x']);
    expect(useStore.getState().live.has('c.d')).toBe(false);
  });

  it('buffers are capped', () => {
    const many: NatsMessage[] = [];
    for (let i = 1; i <= MAX_SUBJECT_MESSAGES + 10; i++) many.push(msg('a.b', i));
    for (let i = 1; i <= MAX_BRANCH_MESSAGES + 10; i++) many.push(msg('a.b.z', 10_000 + i));
    useStore.getState().ingestFeed(many);
    expect(view().messages).toHaveLength(MAX_SUBJECT_MESSAGES);
    expect(view().messages[0].sequence).toBe(11);
    expect(view().branch).toHaveLength(MAX_BRANCH_MESSAGES);
    expect(view().branch[0].sequence).toBe(10_000 + MAX_BRANCH_MESSAGES + 10);
  });

  it('a vanished connection takes its messages with it', () => {
    useStore.getState().setConnections([{ id: 'c1', name: 'one', connected: true } as never, { id: 'c2', name: 'two', connected: true } as never]);
    const stats = { received: 1, throttled: 0, subjects: 1, rate: 0, history: { messages: 1, bytes: 1, subjects: 1 } };
    useStore.getState().setSubscriptionStats('c1', stats);
    useStore.getState().setSubscriptionStats('c2', { ...stats, subjects: 4 });
    expect(useStore.getState().totalSubjects).toBe(5);
    useStore.getState().ingestFeed([msg('a.b', 1, 'c1'), msg('a.b', 2, 'c2')]);
    useStore.getState().setConnections([{ id: 'c1', name: 'one', connected: true } as never]);
    expect(view().messages.map(m => m.connId)).toEqual(['c1']);
    expect(useStore.getState().totalSubjects).toBe(1);
  });
});

describe('tree expansion', () => {
  it('expand all makes the set the collapsed exceptions', () => {
    const s = useStore.getState();
    s.setExpanded(['a']);
    expect(s.isExpanded('a')).toBe(true);
    expect(s.isExpanded('b')).toBe(false);
    s.expandAllBranches();
    expect(s.isExpanded('b')).toBe(true);
    s.toggleExpanded('b');
    expect(s.isExpanded('b')).toBe(false);
    expect(s.isExpanded('a')).toBe(true);
    s.collapseAll();
    expect(s.isExpanded('a')).toBe(false);
  });
});
