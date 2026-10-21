// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appInfo } from '../../lib/storage';
import type { Release, UpdateStatus } from '../../lib/updateCheck';
import { useDesktopUpdate } from '../../store/desktopUpdate';
import { UpdateHint } from './UpdateHint';

const checkForUpdate = vi.fn<() => Promise<Release | null>>();
vi.mock('../../lib/updateCheck', () => ({ checkForUpdate: () => checkForUpdate() }));

const getUpdate = vi.fn<() => Promise<UpdateStatus>>();
const startUpdate = vi.fn<() => Promise<UpdateStatus>>();
const restartForUpdate = vi.fn<() => Promise<{ ok: boolean }>>();
vi.mock('../../lib/api', () => ({
  api: {
    getUpdate: () => getUpdate(),
    startUpdate: () => startUpdate(),
    restartForUpdate: () => restartForUpdate(),
  },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

const initial = { ...appInfo };
const release: Release = { version: '0.7.0', url: 'https://github.com/blanpa/nats-explorer/releases/tag/v0.7.0' };
const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({ supported: true, kind: 'appimage', state: 'idle', ...over });

beforeEach(() => {
  checkForUpdate.mockResolvedValue(release);
});

afterEach(() => {
  Object.assign(appInfo, initial);
  delete appInfo.deployment;
  useDesktopUpdate.setState({ status: null, error: '', restarting: false });
  vi.clearAllMocks();
});

describe('UpdateHint', () => {
  it('shows nothing while this is the newest release and nothing waits', async () => {
    checkForUpdate.mockResolvedValue(null);
    getUpdate.mockResolvedValue(status());
    Object.assign(appInfo, { mode: 'desktop', version: '0.7.0' });
    const { container } = render(<UpdateHint />);
    await waitFor(() => expect(getUpdate).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  // Without internet GitHub names no release, and the update came from files.
  it('offers the restart for a version that waits, without a release from GitHub', async () => {
    checkForUpdate.mockResolvedValue(null);
    getUpdate.mockResolvedValue(status({ state: 'ready', version: '0.7.1', previous: '0.7.0' }));
    Object.assign(appInfo, { mode: 'desktop', version: '0.7.0' });
    render(<UpdateHint />);
    expect(await screen.findByRole('button', { name: /Restart for v0.7.1/ })).toBeInTheDocument();
  });

  it('follows what the settings did', async () => {
    Object.assign(appInfo, { mode: 'desktop', version: '0.6.1' });
    getUpdate.mockResolvedValue(status());
    render(<UpdateHint />);
    await screen.findByRole('button', { name: 'Update' });
    act(() => useDesktopUpdate.setState({ status: status({ state: 'ready', version: '0.6.0', previous: '0.6.1' }) }));
    expect(screen.getByRole('button', { name: /Restart for v0.6.0/ })).toBeInTheDocument();
  });

  it('only links the release on a server', async () => {
    Object.assign(appInfo, { mode: 'server', version: '0.6.1' });
    render(<UpdateHint />);
    expect(await screen.findByRole('link')).toHaveTextContent('v0.7.0 available');
    expect(screen.queryByRole('button')).toBeNull();
    expect(getUpdate).not.toHaveBeenCalled();
  });

  it('tells a server in a container how it takes the release', async () => {
    Object.assign(appInfo, { mode: 'server', version: '0.6.1', deployment: 'docker' });
    render(<UpdateHint />);
    const title = (await screen.findByRole('link')).getAttribute('title');
    expect(title).toContain('docker pull ghcr.io/blanpa/nats-explorer:0.7.0');
    expect(title).toContain('docker compose up -d');
  });

  it('tells a pod to go through helm', async () => {
    Object.assign(appInfo, { mode: 'server', version: '0.6.1', deployment: 'kubernetes' });
    render(<UpdateHint />);
    expect((await screen.findByRole('link')).getAttribute('title')).toContain('helm upgrade with image.tag=0.7.0');
  });

  it('says why a desktop copy that cannot replace itself only links the release', async () => {
    Object.assign(appInfo, { mode: 'desktop', version: '0.6.1' });
    getUpdate.mockResolvedValue(status({ supported: false, kind: undefined, reason: 'installed from the .deb package: the package manager updates it' }));
    render(<UpdateHint />);
    const link = await screen.findByRole('link');
    await waitFor(() => expect(link.getAttribute('title')).toContain('.deb package'));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('downloads, follows the download and restarts when told to', async () => {
    Object.assign(appInfo, { mode: 'desktop', version: '0.6.1' });
    getUpdate.mockResolvedValueOnce(status());
    startUpdate.mockResolvedValue(status({ state: 'downloading', version: '0.7.0', done: 5, total: 10 }));
    restartForUpdate.mockResolvedValue({ ok: true });
    render(<UpdateHint />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    expect(await screen.findByText(/50%/)).toBeInTheDocument();

    getUpdate.mockResolvedValue(status({ state: 'ready', version: '0.7.0' }));
    const again = await screen.findByRole('button', { name: /Restart for v0.7.0/ }, { timeout: 2000 });
    expect(restartForUpdate).not.toHaveBeenCalled();
    fireEvent.click(again);
    await waitFor(() => expect(restartForUpdate).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button')).toHaveTextContent('Restarting');
  });

  it('offers to try again after a failure, with the reason', async () => {
    Object.assign(appInfo, { mode: 'desktop', version: '0.6.1' });
    getUpdate.mockResolvedValue(status());
    startUpdate.mockResolvedValue(
      status({ state: 'failed', version: '0.7.0', error: 'the checksums of release v0.7.0 do not carry the release key signature' }),
    );
    render(<UpdateHint />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    const retry = await screen.findByRole('button', { name: 'Update failed, retry' });
    expect(retry.getAttribute('title')).toContain('release key signature');
    expect(retry.getAttribute('title')).toContain('unchanged');
  });
});
