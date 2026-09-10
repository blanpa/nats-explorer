// @vitest-environment jsdom
import type { HistoryResponse, NatsMessage } from 'shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SUBJECT_MESSAGES, useStore } from '../store';
import { loadOlder } from './feed';

const getHistory = vi.fn<(subject: string, opts: Record<string, unknown>) => Promise<HistoryResponse>>();
vi.mock('./api', () => ({
  api: { getHistory: (subject: string, opts: Record<string, unknown>) => getHistory(subject, opts) },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('./ws', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), on: vi.fn(() => () => undefined), send: vi.fn() } }));

const msg = (sequence: number, connId = 'c1'): NatsMessage => ({
  subject: 'a.b',
  payload: `{"n":${sequence}}`,
  payloadType: 'json',
  timestamp: 1_700_000_000_000 + sequence,
  size: 8,
  sequence,
  connId,
});

const page = (messages: NatsMessage[], more = false): HistoryResponse => ({ subject: 'a.b', messages, branch: [], more });

function setView(messages: NatsMessage[]) {
  useStore.setState({
    live: new Map([
      [
        'a.b',
        {
          subject: 'a.b',
          messages,
          branch: [],
          loading: false,
          error: null,
          cap: MAX_SUBJECT_MESSAGES,
          loadingOlder: false,
          atOldest: false,
          branchCap: 200,
          loadingOlderBranch: false,
          branchAtOldest: false,
        },
      ],
    ]),
  });
}

beforeEach(() => {
  useStore.setState({ live: new Map(), subjectExpr: '' });
  getHistory.mockResolvedValue(page([]));
});
afterEach(() => getHistory.mockReset());

describe('loadOlder', () => {
  it('asks each connection for what it has before its own oldest message', async () => {
    setView([msg(7, 'c1'), msg(4, 'c2'), msg(8, 'c1'), msg(9, 'c2')]);
    getHistory.mockImplementation(async (_s, opts) => page([msg((opts.before as number) - 1, opts.connId as string)], true));

    await loadOlder('a.b');

    expect(getHistory).toHaveBeenCalledTimes(2);
    // Sequences count per connection, so each gets the cursor of its own oldest.
    const calls = getHistory.mock.calls.map(([, opts]) => ({ connId: opts.connId, before: opts.before, branchLimit: opts.branchLimit }));
    expect(calls).toContainEqual({ connId: 'c1', before: 7, branchLimit: 0 });
    expect(calls).toContainEqual({ connId: 'c2', before: 4, branchLimit: 0 });

    // c1 pages back from 7, c2 from 4; both results merge into one list.
    const v = useStore.getState().live.get('a.b');
    expect(v?.messages.map(m => m.sequence)).toEqual([3, 4, 6, 7, 8, 9]);
    expect(v?.atOldest).toBe(false);
    expect(v?.loadingOlder).toBe(false);
  });

  it('is done when no connection reports more, not when a page looks short', async () => {
    setView([msg(5)]);
    // A payload filter can empty a full page: `more` is what decides.
    getHistory.mockResolvedValue(page([], true));
    await loadOlder('a.b');
    expect(useStore.getState().live.get('a.b')?.atOldest).toBe(false);

    getHistory.mockResolvedValue(page([msg(4)], false));
    await loadOlder('a.b');
    expect(useStore.getState().live.get('a.b')?.atOldest).toBe(true);
  });

  it('does not ask again while a page is in flight or once the end is reached', async () => {
    setView([msg(5)]);
    let release: (() => void) | undefined;
    getHistory.mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve(page([msg(4)], false));
        }),
    );
    const first = loadOlder('a.b');
    await loadOlder('a.b'); // while the first is still open
    expect(getHistory).toHaveBeenCalledTimes(1);
    release?.();
    await first;

    await loadOlder('a.b'); // atOldest now
    expect(getHistory).toHaveBeenCalledTimes(1);
  });

  it('keeps what is loaded when a page fails', async () => {
    setView([msg(5)]);
    getHistory.mockRejectedValue(new Error('boom'));
    await loadOlder('a.b');

    const v = useStore.getState().live.get('a.b');
    expect(v?.messages.map(m => m.sequence)).toEqual([5]);
    expect(v?.loadingOlder).toBe(false);
    expect(v?.error).toBeNull();
  });
});
