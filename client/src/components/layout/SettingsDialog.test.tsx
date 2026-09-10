// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HistoryPersistence } from 'shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../lib/auth';
import { useStore } from '../../store';
import SettingsDialog, { parseGoDuration } from './SettingsDialog';

const getHistoryPersistence = vi.fn<() => Promise<HistoryPersistence>>();
const setHistoryPersistence = vi.fn<(input: { enabled: boolean; retention?: string; purge?: boolean }) => Promise<HistoryPersistence>>();
vi.mock('../../lib/api', () => ({
  api: {
    getHistoryPersistence: () => getHistoryPersistence(),
    setHistoryPersistence: (input: { enabled: boolean; retention?: string; purge?: boolean }) => setHistoryPersistence(input),
  },
  errorMessage: (e: unknown) => String(e),
}));

const status = (over: Partial<HistoryPersistence> = {}): HistoryPersistence => ({
  supported: true,
  managed: false,
  enabled: false,
  path: '/home/u/.config/nats-explorer/history.db',
  retention: '72h0m0s',
  ...over,
});

beforeEach(() => {
  useStore.setState({ settingsOpen: true, historyDb: false, historyRetention: '' });
  useAuth.setState({ mode: 'none', role: 'admin' });
  getHistoryPersistence.mockResolvedValue(status());
  setHistoryPersistence.mockImplementation(async input => status({ enabled: input.enabled, retention: input.retention === '24h' ? '24h0m0s' : '72h0m0s' }));
});
afterEach(() => {
  getHistoryPersistence.mockReset();
  setHistoryPersistence.mockReset();
});

describe('parseGoDuration', () => {
  it('reads the durations the backend sends', () => {
    expect(parseGoDuration('72h0m0s')).toBe(72 * 3600);
    expect(parseGoDuration('1h30m0s')).toBe(5400);
    expect(parseGoDuration('500ms')).toBe(0.5);
    expect(parseGoDuration('nonsense')).toBe(0);
  });
});

describe('SettingsDialog', () => {
  it('switches the history to disk and tells the rest of the app', async () => {
    render(<SettingsDialog />);
    const toggle = await screen.findByRole('checkbox', { name: /Keep the history on disk/ });
    expect(toggle).not.toBeChecked();
    // Nothing changed yet, so there is nothing to save.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.click(toggle);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '24h' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setHistoryPersistence).toHaveBeenCalledWith({ enabled: true, retention: '24h', fullText: true, purge: false }));
    // The range picker and the bundle dialog read this.
    await waitFor(() => expect(useStore.getState().historyDb).toBe(true));
    expect(useStore.getState().historyRetention).toBe('24h0m0s');
  });

  it('offers to delete the stored messages when switching off', async () => {
    getHistoryPersistence.mockResolvedValue(
      status({ enabled: true, db: { path: 'x', messages: 12, bytes: 4096, oldest: 0, dropped: 0, retention: '72h0m0s' } }),
    );
    render(<SettingsDialog />);
    const toggle = await screen.findByRole('checkbox', { name: /Keep the history on disk/ });
    expect(screen.queryByRole('checkbox', { name: /Delete what is already stored/ })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Delete what is already stored/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setHistoryPersistence).toHaveBeenCalledWith({ enabled: false, retention: '72h', fullText: true, purge: true }));
  });

  it('trades the full-text index for write throughput', async () => {
    getHistoryPersistence.mockResolvedValue(status({ enabled: true, fullText: true }));
    render(<SettingsDialog />);
    const index = await screen.findByRole('checkbox', { name: /Full-text index/ });
    expect(index).toBeChecked();
    fireEvent.click(index);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setHistoryPersistence).toHaveBeenCalledWith({ enabled: true, retention: '72h', fullText: false, purge: false }));
  });

  it('reports an installation configured by HISTORY_DB instead of editing it', async () => {
    getHistoryPersistence.mockResolvedValue(status({ managed: true, enabled: true }));
    render(<SettingsDialog />);
    expect(await screen.findByRole('checkbox', { name: /Keep the history on disk/ })).toBeDisabled();
    expect(screen.getByText(/HISTORY_DB/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('says why a browser-storage server cannot persist the history', async () => {
    getHistoryPersistence.mockResolvedValue(status({ supported: false, path: undefined, reason: 'start the server with STORAGE_DIR' }));
    render(<SettingsDialog />);
    expect(await screen.findByText(/STORAGE_DIR/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
