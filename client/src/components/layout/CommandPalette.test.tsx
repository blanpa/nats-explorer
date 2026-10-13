// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import { useSavedConnections } from '../../store/savedConnections';
import CommandPalette from './CommandPalette';

vi.mock('../../lib/api', () => ({ api: {}, errorMessage: (e: unknown) => String(e) }));

beforeEach(() => {
  useStore.setState({ paletteOpen: true, module: 'subjects', connections: [], activeConnId: null });
  useSavedConnections.setState({
    items: [{ id: 'c1', name: 'Plant', servers: ['nats://plant:4222'], authMethod: 'none', subscriptions: ['>'], sysTopics: {} }],
    connecting: new Set(),
  });
});

describe('CommandPalette', () => {
  it('narrows to what is typed and runs the first match on Enter', () => {
    render(<CommandPalette />);
    const input = screen.getByLabelText('Search commands');
    fireEvent.change(input, { target: { value: 'jet' } });
    expect(screen.getByRole('option', { name: /JetStream/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Alerts/ })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useStore.getState().module).toBe('jetstream');
    expect(useStore.getState().paletteOpen).toBe(false);
  });

  it('offers to connect a saved connection that is closed', () => {
    const connect = vi.fn(async () => true);
    useSavedConnections.setState({ connect });
    render(<CommandPalette />);
    fireEvent.click(screen.getByRole('option', { name: /Connect Plant/ }));
    expect(connect).toHaveBeenCalledWith('c1');
  });

  it('walks the list with the arrows', () => {
    render(<CommandPalette />);
    const input = screen.getByLabelText('Search commands');
    fireEvent.change(input, { target: { value: 'go to' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useStore.getState().module).toBe('state');
  });
});
