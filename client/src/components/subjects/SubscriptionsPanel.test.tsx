// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ConnectionStatus } from 'shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../lib/auth';
import { useStore } from '../../store';
import SubscriptionsPanel from './SubscriptionsPanel';

const setSubscriptions = vi.fn(async (_connId: string, _subs: string[]) => undefined);
vi.mock('../../lib/api', () => ({
  api: { setSubscriptions: (connId: string, subs: string[]) => setSubscriptions(connId, subs) },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock('../../lib/feed', () => ({ loadHistory: vi.fn(async () => undefined) }));

const conn = (over: Partial<ConnectionStatus> = {}): ConnectionStatus => ({
  id: 'c1',
  name: 'Demo',
  connected: true,
  reconnecting: false,
  color: '#0af',
  reconnects: 0,
  subscriptions: ['orders.>', '$KV.>'],
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    connections: [conn()],
    subscriptionStats: new Map([
      [
        'c1',
        {
          subjects: 12,
          received: 100,
          throttled: 0,
          rate: 3,
          history: { messages: 100, bytes: 4096, subjects: 12 },
          patterns: [{ pattern: 'orders.>', subjects: 12, received: 100, rate: 3 }],
        },
      ],
    ]),
  });
});
afterEach(() => {
  setSubscriptions.mockClear();
  useAuth.setState({ mode: 'none', role: 'admin' });
});

describe('SubscriptionsPanel', () => {
  it('lists the patterns with their stats and the active system toggles', () => {
    render(<SubscriptionsPanel />);
    expect(screen.getByText('orders.>')).toBeInTheDocument();
    expect(screen.getAllByText(/12 subj/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /\$KV/, pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\$JS/, pressed: false })).toBeInTheDocument();
  });

  it('applies an added pattern at once', async () => {
    render(<SubscriptionsPanel />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Add subscription to Demo' }), { target: { value: 'metrics.*, events.>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add subscription to Demo' }));
    await waitFor(() => expect(setSubscriptions).toHaveBeenCalledWith('c1', ['orders.>', 'metrics.*', 'events.>', '$KV.>']));
  });

  it('replaces the catch-all when a concrete pattern is added', async () => {
    useStore.setState({ connections: [conn({ subscriptions: ['>'] })] });
    render(<SubscriptionsPanel />);
    // collapsed by default with only the catch-all: open it first
    fireEvent.click(screen.getByRole('button', { name: /Subscriptions/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Add subscription to Demo' }), { target: { value: 'orders.>' } });
    fireEvent.submit(screen.getByRole('textbox', { name: 'Add subscription to Demo' }).closest('form')!);
    await waitFor(() => expect(setSubscriptions).toHaveBeenCalledWith('c1', ['orders.>']));
  });

  it('hides the editing controls from a viewer', () => {
    useAuth.setState({ mode: 'users', role: 'viewer' });
    render(<SubscriptionsPanel />);
    expect(screen.getByText('orders.>')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Add subscription to Demo', hidden: true }).closest('form')).not.toBeVisible();
    expect(screen.getByTitle('Unsubscribe orders.>')).not.toBeVisible();
  });
});

describe('removing every subscription', () => {
  it('really removes the wildcard instead of putting it back', async () => {
    useStore.setState({ connections: [conn({ subscriptions: ['>'] })] });
    render(<SubscriptionsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^Subscriptions/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unsubscribe >' }));
    // The wildcard is the one pattern nobody can afford on a busy cluster;
    // sending ['>'] back would make it the only one that cannot go.
    await waitFor(() => expect(setSubscriptions).toHaveBeenCalledWith('c1', []));
  });

  it('says that nothing is subscribed rather than showing a count', async () => {
    useStore.setState({ connections: [conn({ subscriptions: [] })] });
    render(<SubscriptionsPanel />);
    // Exact text, so the longer explanation below it is not what matches.
    expect(screen.getByText('no subscriptions')).toBeInTheDocument();
    // A connection listening to nothing opens the panel by itself: that is
    // the state most in need of explaining.
    expect(await screen.findByText(/this connection receives nothing/)).toBeInTheDocument();
  });

  it('keeps the system toggles working with no own pattern', async () => {
    useStore.setState({ connections: [conn({ subscriptions: [] })] });
    render(<SubscriptionsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /\$JS/ }));
    await waitFor(() => expect(setSubscriptions).toHaveBeenCalledWith('c1', ['$JS.>']));
  });
});
