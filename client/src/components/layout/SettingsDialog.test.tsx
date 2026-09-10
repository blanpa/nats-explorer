// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HistoryPersistence } from 'shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../lib/auth';
import { useStore } from '../../store';
import SettingsDialog, { parseGoDuration } from './SettingsDialog';

const getHistoryPersistence = vi.fn<() => Promise<HistoryPersistence>>();
type SetInput = { enabled: boolean; retention?: string; fullText?: boolean; filter?: string; queueBytes?: number; purge?: boolean };
const setHistoryPersistence = vi.fn<(input: SetInput) => Promise<HistoryPersistence>>();
vi.mock('../../lib/api', () => ({
  api: {
    getHistoryPersistence: () => getHistoryPersistence(),
    setHistoryPersistence: (input: SetInput) => setHistoryPersistence(input),
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

const dbStats = (over: Partial<HistoryPersistence['db']> = {}) => ({
  path: 'x',
  messages: 12,
  bytes: 4096,
  oldest: 0,
  dropped: 0,
  filtered: 0,
  queued: 0,
  queueBytes: 64 << 20,
  retention: '72h0m0s',
  ...over,
});

/** What every save now carries, so a test only names what it is about. */
const saved = (over: Partial<SetInput>): SetInput => ({
  enabled: true,
  retention: '72h',
  fullText: true,
  filter: '',
  queueBytes: 64 << 20,
  purge: false,
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
    fireEvent.change(screen.getByLabelText('Keep messages for'), { target: { value: '24h' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setHistoryPersistence).toHaveBeenCalledWith(saved({ retention: '24h' })));
    // The range picker and the bundle dialog read this.
    await waitFor(() => expect(useStore.getState().historyDb).toBe(true));
    expect(useStore.getState().historyRetention).toBe('24h0m0s');
  });

  it('offers to delete the stored messages when switching off', async () => {
    getHistoryPersistence.mockResolvedValue(status({ enabled: true, db: dbStats() }));
    render(<SettingsDialog />);
    const toggle = await screen.findByRole('checkbox', { name: /Keep the history on disk/ });
    expect(screen.queryByRole('checkbox', { name: /Delete what is already stored/ })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Delete what is already stored/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setHistoryPersistence).toHaveBeenCalledWith(saved({ enabled: false, purge: true })));
  });

  it('trades the full-text index for write throughput', async () => {
    getHistoryPersistence.mockResolvedValue(status({ enabled: true, fullText: true }));
    render(<SettingsDialog />);
    const index = await screen.findByRole('checkbox', { name: /Full-text index/ });
    expect(index).toBeChecked();
    fireEvent.click(index);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setHistoryPersistence).toHaveBeenCalledWith(saved({ fullText: false })));
  });

  it('says what to do about messages that did not reach the disk', async () => {
    getHistoryPersistence.mockResolvedValue(status({ enabled: true, fullText: true, db: dbStats({ dropped: 4321 }) }));
    render(<SettingsDialog />);
    expect(await screen.findByText(/4,321 messages did not reach the disk/)).toBeInTheDocument();
    // The live view is not what has gaps, and saying so is half the point.
    expect(screen.getByText(/live view and the subject tree are unaffected/)).toBeInTheDocument();
    // The remedies, cheapest first.
    expect(screen.getByText(/write only the subjects that are searched for/)).toBeInTheDocument();
    expect(screen.getByText(/switch the full-text index off/)).toBeInTheDocument();
    expect(screen.getByText(/raise the write buffer/)).toBeInTheDocument();
  });

  it('leaves out the remedies that are already in place', async () => {
    getHistoryPersistence.mockResolvedValue(
      status({ enabled: true, fullText: false, filter: 'size > 10', queueBytes: 1024 << 20, db: dbStats({ dropped: 7, queueBytes: 1024 << 20 }) }),
    );
    render(<SettingsDialog />);
    expect(await screen.findByText(/7 messages did not reach the disk/)).toBeInTheDocument();
    expect(screen.queryByText(/write only the subjects/)).not.toBeInTheDocument();
    expect(screen.queryByText(/full-text index off/)).not.toBeInTheDocument();
    expect(screen.queryByText(/raise the write buffer/)).not.toBeInTheDocument();
  });

  it('sends the persist filter and the write buffer', async () => {
    getHistoryPersistence.mockResolvedValue(status({ enabled: true, db: dbStats() }));
    render(<SettingsDialog />);
    fireEvent.change(await screen.findByLabelText('Only write messages matching'), { target: { value: 'subject.startsWith("orders.")' } });
    fireEvent.change(screen.getByLabelText('Write buffer'), { target: { value: String(256 << 20) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setHistoryPersistence).toHaveBeenCalledWith(saved({ filter: 'subject.startsWith("orders.")', queueBytes: 256 << 20 })));
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
