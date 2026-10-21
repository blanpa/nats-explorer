import { useEffect, useState } from 'react';
import { ArrowUpCircle, Download, RotateCw } from 'lucide-react';
import { api } from '../../lib/api';
import { appInfo } from '../../lib/storage';
import { checkForUpdate, type Release } from '../../lib/updateCheck';
import { cn, formatBytes } from '../../lib/utils';
import { useDesktopUpdate } from '../../store/desktopUpdate';

/**
 * How a server takes a release, which it never does by itself: a container
 * through its image and whatever runs it, a binary by being replaced.
 */
function howToUpdate(version: string): string {
  const image = `ghcr.io/blanpa/nats-explorer:${version}`;
  switch (appInfo.deployment) {
    case 'docker':
      return ` This container is updated through its image: docker pull ${image}, then recreate the container (docker compose pull && docker compose up -d).`;
    case 'container':
      return ` This container is updated through its image: podman pull ${image}, then recreate the container.`;
    case 'kubernetes':
      return ` This pod is updated through its image: helm upgrade with image.tag=${version}, or the chart of the release.`;
  }
  return ' The server is updated by replacing its binary with the server package of the release.';
}

/**
 * A newer release, when there is one: a quiet link beside the version,
 * because the desktop app has no store to tell it and a server left
 * running for months has nobody looking. The desktop app also puts the
 * release in place itself when asked, and restarts into it when told to:
 * a restart closes the live views, so it is never done unasked.
 */
export function UpdateHint() {
  const [release, setRelease] = useState<Release | null>(null);
  const { status: update, restarting, refresh, run, restart } = useDesktopUpdate();
  const desktop = appInfo.mode === 'desktop';

  useEffect(() => {
    let live = true;
    checkForUpdate(appInfo.version).then(r => live && setRelease(r));
    return () => {
      live = false;
    };
  }, []);

  // Asked whether or not GitHub answered: a version brought along from
  // files, or taken back, waits for its restart here too.
  useEffect(() => {
    if (desktop) refresh();
  }, [desktop, refresh]);

  // The download is followed until the new version is in place, or is not.
  const downloading = update?.state === 'downloading';
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(refresh, 500);
    return () => clearInterval(t);
  }, [downloading, refresh]);

  if (update?.supported && update.state === 'ready') {
    return (
      <button
        type="button"
        onClick={restart}
        disabled={restarting}
        className="flex items-center gap-1 text-accent hover:underline shrink-0 disabled:opacity-60"
        title={`NATS Explorer ${update.version} is in place and runs from the next start. Restarting closes the window and opens it again; live views start over.`}
      >
        <RotateCw size={12} className={cn(restarting && 'animate-spin')} /> {restarting ? 'Restarting…' : `Restart for v${update.version}`}
      </button>
    );
  }

  if (update?.supported && update.state === 'downloading') {
    const { done = 0, total = 0 } = update;
    const progress = total > 0 ? `${Math.floor((done / total) * 100)}%` : done > 0 ? formatBytes(done) : '…';
    return (
      <span
        className="flex items-center gap-1 text-faint shrink-0 font-mono tabular-nums"
        title="Downloading the release and checking its signature and checksum"
      >
        <Download size={12} /> v{update.version ?? release?.version} {progress}
      </span>
    );
  }

  if (!release) return null;

  const why = desktop
    ? update && !update.supported && update.reason
      ? ` This copy does not update itself: ${update.reason}.`
      : ''
    : howToUpdate(release.version);
  const link = (
    <a
      href={release.url}
      target="_blank"
      rel="noreferrer"
      onClick={e => {
        const browserOpen = window.runtime?.BrowserOpenURL;
        if (desktop && browserOpen) {
          e.preventDefault();
          browserOpen(release.url);
        }
      }}
      className="flex items-center gap-1 text-accent hover:underline shrink-0"
      title={`NATS Explorer ${release.version} is out; this is ${appInfo.version}. Opens the release.${why}`}
    >
      <ArrowUpCircle size={12} /> v{release.version} available
    </a>
  );
  if (!update?.supported) return link;

  const failed = update.state === 'failed';
  return (
    <span className="flex items-center gap-2 shrink-0">
      {link}
      <button
        type="button"
        onClick={() => run(api.startUpdate)}
        className={cn('hover:underline', failed ? 'text-warn' : 'text-accent')}
        title={
          failed
            ? `The update did not go through: ${update.error}. This copy is unchanged. Click to try again.`
            : `Downloads ${release.version}, checks that the release key signed it and puts it in place of this copy. The app restarts when you say so.`
        }
      >
        {failed ? 'Update failed, retry' : 'Update'}
      </button>
    </span>
  );
}
