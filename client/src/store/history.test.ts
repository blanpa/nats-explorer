// @vitest-environment jsdom
import type { NatsMessage } from 'shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_LOADED_MESSAGES, MAX_SUBJECT_MESSAGES, type LiveView, useStore } from './index';

const msg = (sequence: number, subject = 'a.b'): NatsMessage => ({
  subject,
  payload: `{"n":${sequence}}`,
  payloadType: 'json',
  timestamp: 1_700_000_000_000 + sequence,
  size: 8,
  sequence,
  connId: 'c1',
});

/** A view holding the messages with the given sequences, oldest first. */
function view(sequences: number[], over: Partial<LiveView> = {}): LiveView {
  return {
    subject: 'a.b',
    messages: sequences.map(n => msg(n)),
    branch: [],
    loading: false,
    error: null,
    cap: MAX_SUBJECT_MESSAGES,
    loadingOlder: false,
    atOldest: false,
    branchCap: 200,
    loadingOlderBranch: false,
    branchAtOldest: false,
    ...over,
  };
}

function setView(v: LiveView) {
  useStore.setState({ live: new Map([[v.subject, v]]) });
}

const seqs = () =>
  useStore
    .getState()
    .live.get('a.b')
    ?.messages.map(m => m.sequence);

beforeEach(() => {
  useStore.setState({ live: new Map(), selectedMessage: null });
});

describe('paging backwards through the history', () => {
  it('puts an older page in front and lets the view grow past one page', () => {
    setView(view([11, 12, 13]));
    useStore.getState().prependOlder('a.b', [msg(9), msg(10)], false);

    const v = useStore.getState().live.get('a.b');
    expect(v?.messages.map(m => m.sequence)).toEqual([9, 10, 11, 12, 13]);
    expect(v?.loadingOlder).toBe(false);
    expect(v?.atOldest).toBe(false);
  });

  it('does not drop a page it just fetched when the feed delivers again', () => {
    // A full view: without a growing cap the next live message would push
    // the messages just paged in straight back out.
    setView(view(Array.from({ length: MAX_SUBJECT_MESSAGES }, (_, i) => i + 1000)));
    useStore.getState().prependOlder('a.b', [msg(1), msg(2)], false);
    useStore.getState().ingestFeed([msg(9999)]);

    const kept = useStore.getState().live.get('a.b')?.messages ?? [];
    expect(kept[0].sequence).toBe(1);
    expect(kept[kept.length - 1].sequence).toBe(9999);
  });

  it('keeps the loaded messages when the live feed delivers more', () => {
    setView(view([1, 2], { cap: 4 }));
    useStore.getState().ingestFeed([msg(3), msg(4)]);
    expect(seqs()).toEqual([1, 2, 3, 4]);
    // Only now, at the cap, does the oldest go.
    useStore.getState().ingestFeed([msg(5)]);
    expect(seqs()).toEqual([2, 3, 4, 5]);
  });

  it('ignores messages it already holds, so an overlapping page changes nothing', () => {
    setView(view([3, 4]));
    useStore.getState().prependOlder('a.b', [msg(2), msg(3), msg(4)], false);
    expect(seqs()).toEqual([2, 3, 4]);
  });

  it('sorts pages of several connections into one list', () => {
    const other = (n: number): NatsMessage => ({ ...msg(n), connId: 'c2', timestamp: 1_700_000_000_000 + n });
    setView(view([5, 6]));
    useStore.getState().prependOlder('a.b', [msg(3), other(4), other(2)], false);
    expect(
      useStore
        .getState()
        .live.get('a.b')
        ?.messages.map(m => m.timestamp),
    ).toEqual([2, 3, 4, 5, 6].map(n => 1_700_000_000_000 + n));
  });

  it('stops at the ceiling even when the server has more', () => {
    const loaded = Array.from({ length: MAX_LOADED_MESSAGES - 1 }, (_, i) => i + 2);
    setView(view(loaded, { cap: MAX_LOADED_MESSAGES }));
    useStore.getState().prependOlder('a.b', [msg(0), msg(1)], false);

    const v = useStore.getState().live.get('a.b');
    expect(v?.messages).toHaveLength(MAX_LOADED_MESSAGES);
    expect(v?.atOldest).toBe(true);
    // The newest are kept, the surplus falls off the old end.
    expect(v?.messages[v.messages.length - 1].sequence).toBe(MAX_LOADED_MESSAGES);
  });

  it('marks the end when the server reports nothing older', () => {
    setView(view([2, 3]));
    useStore.getState().prependOlder('a.b', [msg(1)], true);
    expect(useStore.getState().live.get('a.b')?.atOldest).toBe(true);
  });

  it('lets a narrowed payload filter take messages away', () => {
    setView(view([5, 6, 7]));
    // Merging is right for a refresh: the feed may have delivered while the
    // request was in flight.
    useStore.getState().applyHistory('a.b', { subject: 'a.b', messages: [msg(5)], branch: [] });
    expect(seqs()).toEqual([5, 6, 7]);
    // With replace the answer is the whole truth.
    useStore.getState().applyHistory('a.b', { subject: 'a.b', messages: [msg(5)], branch: [] }, true);
    expect(seqs()).toEqual([5]);
  });

  it('appends an older page below a branch and lets that list grow too', () => {
    // The branch list is newest first, so older messages go to the end.
    setView(view([], { branch: [msg(9, 'a.b.x'), msg(8, 'a.b.y')], branchCap: 2 }));
    useStore.getState().appendOlderBranch('a.b', [msg(7, 'a.b.x'), msg(6, 'a.b.y')], false);

    const v = useStore.getState().live.get('a.b');
    expect(v?.branch.map(m => m.sequence)).toEqual([9, 8, 7, 6]);
    expect(v?.branchAtOldest).toBe(false);
    expect(v?.loadingOlderBranch).toBe(false);
    // With room above the loaded page, a live message does not push it out.
    useStore.getState().ingestFeed([msg(10, 'a.b.z')]);
    expect(
      useStore
        .getState()
        .live.get('a.b')
        ?.branch.map(m => m.sequence),
    ).toEqual([10, 9, 8, 7, 6]);
  });

  it('does not add a branch message twice', () => {
    setView(view([], { branch: [msg(9, 'a.b.x'), msg(8, 'a.b.y')] }));
    useStore.getState().appendOlderBranch('a.b', [msg(8, 'a.b.y'), msg(7, 'a.b.x')], true);
    const v = useStore.getState().live.get('a.b');
    expect(v?.branch.map(m => m.sequence)).toEqual([9, 8, 7]);
    expect(v?.branchAtOldest).toBe(true);
  });

  it('starts the paging over when the history is loaded again', () => {
    setView(view([5, 6], { cap: 4000, atOldest: true }));
    useStore.getState().applyHistory('a.b', { subject: 'a.b', messages: [msg(7)], branch: [] });

    const v = useStore.getState().live.get('a.b');
    expect(v?.cap).toBe(MAX_SUBJECT_MESSAGES);
    expect(v?.atOldest).toBe(false);
  });
});
