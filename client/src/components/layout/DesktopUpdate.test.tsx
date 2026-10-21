// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appInfo } from '../../lib/storage';
import type { UpdateStatus } from '../../lib/updateCheck';
import { useDesktopUpdate } from '../../store/desktopUpdate';
import { DesktopUpdate } from './DesktopUpdate';

const getUpdate = vi.fn<() => Promise<UpdateStatus>>();
const installUpdateFiles = vi.fn<(files: File[]) => Promise<UpdateStatus>>();
const restartForUpdate = vi.fn<() => Promise<{ ok: boolean }>>();
const rollbackUpdate = vi.fn<() => Promise<UpdateStatus>>();
vi.mock('../../lib/api', () => ({
  api: {
    getUpdate: () => getUpdate(),
    installUpdateFiles: (files: File[]) => installUpdateFiles(files),
    restartForUpdate: () => restartForUpdate(),
    rollbackUpdate: () => rollbackUpdate(),
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  supported: true,
  kind: 'tarball',
  state: 'idle',
  asset: 'nats-explorer-desktop-<version>-linux-x64.tar.gz',
  ...over,
});

const release = [
  new File(['package'], 'nats-explorer-desktop-0.7.0-linux-x64.tar.gz'),
  new File(['sums'], 'SHA256SUMS.txt'),
  new File(['sig'], 'SHA256SUMS.txt.sig'),
];

function choose(container: HTMLElement, files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

const initial = { ...appInfo };

afterEach(() => {
  Object.assign(appInfo, initial);
  useDesktopUpdate.setState({ status: null, error: '', restarting: false });
  vi.clearAllMocks();
});

describe('DesktopUpdate', () => {
  it('names the file this installation needs, installs it and offers the restart', async () => {
    getUpdate.mockResolvedValue(status());
    installUpdateFiles.mockResolvedValue(status({ state: 'ready', version: '0.7.0' }));
    restartForUpdate.mockResolvedValue({ ok: true });
    const { container } = render(<DesktopUpdate />);

    expect(await screen.findByText('nats-explorer-desktop-<version>-linux-x64.tar.gz')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restart/ })).toBeNull();

    choose(container, release);
    await waitFor(() => expect(installUpdateFiles).toHaveBeenCalledWith(release));
    fireEvent.click(await screen.findByRole('button', { name: /Restart for v0.7.0/ }));
    await waitFor(() => expect(restartForUpdate).toHaveBeenCalledTimes(1));
  });

  it('says what was wrong with the files', async () => {
    getUpdate.mockResolvedValue(status());
    installUpdateFiles.mockRejectedValue(new Error("these checksums do not carry the release key's signature"));
    const { container } = render(<DesktopUpdate />);
    await screen.findByRole('button', { name: /Install from files/ });

    choose(container, release);
    expect(await screen.findByText(/release key's signature/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restart/ })).toBeNull();
  });

  it('offers to go back to the version the last update replaced, and forward again', async () => {
    Object.assign(appInfo, { version: '0.7.0' });
    getUpdate.mockResolvedValue(status({ previous: '0.6.1' }));
    rollbackUpdate.mockResolvedValueOnce(status({ state: 'ready', version: '0.6.1', previous: '0.7.0' }));
    render(<DesktopUpdate />);

    const back = await screen.findByRole('button', { name: /Back to v0.6.1/ });
    expect(back.getAttribute('title')).toContain('Connections, settings and the history stay');
    fireEvent.click(back);
    await waitFor(() => expect(rollbackUpdate).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: /Restart for v0.6.1/ })).toBeInTheDocument();
    // Back to what runs, which takes the rollback back.
    expect(screen.getByRole('button', { name: /Back to v0.7.0/ })).toBeInTheDocument();
  });

  it('names a newer version kept to go back to a switch', async () => {
    Object.assign(appInfo, { version: '0.7.0' });
    getUpdate.mockResolvedValue(status({ previous: '0.7.1' }));
    render(<DesktopUpdate />);
    expect(await screen.findByRole('button', { name: /Switch to v0.7.1/ })).toBeInTheDocument();
  });

  // A refused second update must not hide the one waiting for its restart.
  it('keeps the restart offered when files are refused while an update waits', async () => {
    Object.assign(appInfo, { version: '0.7.0' });
    getUpdate.mockResolvedValue(status({ state: 'ready', version: '0.7.1', previous: '0.7.0' }));
    installUpdateFiles.mockRejectedValue(new Error('0.7.1 is already in place: restart first'));
    const { container } = render(<DesktopUpdate />);
    await screen.findByRole('button', { name: /Restart for v0.7.1/ });

    choose(container, release);
    expect(await screen.findByText(/restart first/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Restart for v0.7.1/ })).toBeInTheDocument();
  });

  it('offers no way back where no previous version is kept', async () => {
    getUpdate.mockResolvedValue(status());
    render(<DesktopUpdate />);
    await screen.findByRole('button', { name: /Install from files/ });
    expect(screen.queryByRole('button', { name: /Back to|Switch to/ })).toBeNull();
  });

  it('says why a copy that cannot replace itself offers nothing', async () => {
    getUpdate.mockResolvedValue(status({ supported: false, asset: undefined, reason: 'installed from the .deb package: the package manager updates it' }));
    render(<DesktopUpdate />);
    expect(await screen.findByText(/package manager updates it/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
