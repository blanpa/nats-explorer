import type { NatsMessage } from 'shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_MAX_MESSAGES, fetchWholeRange } from './exportRange';

const getHistoryRange = vi.fn();
vi.mock('./api', () => ({ api: { getHistoryRange: (...args: unknown[]) => getHistoryRange(...args) } }));

const msg = (seq: number, connId = 'c1'): NatsMessage => ({
  subject: 'plant.robot',
  payload: '{}',
  payloadType: 'json',
  timestamp: 1_000_000 - seq,
  size: 2,
  sequence: seq,
  connId,
});

const range = { from: 0, to: 2_000_000 };

afterEach(() => getHistoryRange.mockReset());

describe('fetchWholeRange', () => {
  it('asks for nothing when the first page was the whole range', async () => {
    const seed = { messages: [msg(3), msg(2)], more: false };
    const out = await fetchWholeRange('plant.robot', range, seed);
    expect(getHistoryRange).not.toHaveBeenCalled();
    expect(out.messages).toHaveLength(2);
    expect(out.truncated).toBe(false);
  });

  it('keeps paging until the server says there is no more', async () => {
    getHistoryRange.mockResolvedValueOnce({ messages: [msg(8), msg(7)], more: true }).mockResolvedValueOnce({ messages: [msg(6)], more: false });
    const out = await fetchWholeRange('plant.robot', range, { messages: [msg(10), msg(9)], more: true });
    expect(getHistoryRange).toHaveBeenCalledTimes(2);
    expect(out.messages.map(m => m.sequence)).toEqual([10, 9, 8, 7, 6]);
    expect(out.truncated).toBe(false);
  });

  it('pages every connection on its own cursor', async () => {
    getHistoryRange.mockResolvedValue({ messages: [], more: false });
    await fetchWholeRange('plant.robot', range, { messages: [msg(5, 'a'), msg(4, 'b')], more: true });
    // Sequences count per connection, so one shared cursor would skip
    // messages of whichever connection is behind.
    expect(getHistoryRange).toHaveBeenCalledTimes(2);
    const conns = getHistoryRange.mock.calls.map(c => c[1].connId).sort();
    expect(conns).toEqual(['a', 'b']);
  });

  it('reports how far it has got', async () => {
    getHistoryRange.mockResolvedValueOnce({ messages: [msg(8)], more: true }).mockResolvedValueOnce({ messages: [msg(7)], more: false });
    const seen: number[] = [];
    await fetchWholeRange('plant.robot', range, { messages: [msg(9)], more: true }, n => seen.push(n));
    expect(seen).toEqual([2, 3]);
  });

  it('stops at the ceiling and says the file is short', async () => {
    // Always more, always a full page: without a ceiling this never ends.
    getHistoryRange.mockImplementation(async () => ({
      messages: Array.from({ length: 5000 }, (_, i) => msg(100_000 + i)),
      more: true,
    }));
    const out = await fetchWholeRange('plant.robot', range, { messages: [msg(1)], more: true });
    expect(out.messages.length).toBeGreaterThanOrEqual(EXPORT_MAX_MESSAGES);
    expect(out.truncated).toBe(true);
  });

  it('gives up when a page brings nothing rather than asking forever', async () => {
    getHistoryRange.mockResolvedValue({ messages: [], more: true });
    const out = await fetchWholeRange('plant.robot', range, { messages: [msg(1)], more: true });
    expect(getHistoryRange).toHaveBeenCalledTimes(1);
    expect(out.messages).toHaveLength(1);
  });

  it('stops when no message names a connection to page from', async () => {
    const out = await fetchWholeRange('plant.robot', range, { messages: [{ ...msg(1), connId: undefined }], more: true });
    expect(getHistoryRange).not.toHaveBeenCalled();
    expect(out.messages).toHaveLength(1);
  });
});
