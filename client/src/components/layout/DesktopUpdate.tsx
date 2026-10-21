import { useEffect, useRef, useState } from 'react';
import { FolderOpen, RotateCw, Undo2 } from 'lucide-react';
import { api } from '../../lib/api';
import { appInfo } from '../../lib/storage';
import { isNewer, type UpdateStatus } from '../../lib/updateCheck';
import { useDesktopUpdate } from '../../store/desktopUpdate';
import { Button } from '../ui/Button';

/**
 * The desktop app's own update, beyond the button in the status bar:
 *
 * - for a machine without internet, a release downloaded elsewhere and
 *   brought along, which the backend checks the way it checks a download --
 *   the release key signed the checksums, they list the package under this
 *   installation's name, and it is newer -- before it puts it in place. The
 *   name of the package to bring is the backend's, since only it knows how
 *   this copy was installed;
 * - the version the last update replaced, back in place, for a release that
 *   does not work out.
 *
 * Either runs from the next start, or from the restart offered here and in
 * the status bar, which share the state.
 */
export function DesktopUpdate() {
  const { status, error, restarting, refresh, run, restart } = useDesktopUpdate();
  const [busy, setBusy] = useState<'' | 'files' | 'rollback'>('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!status) return null;
  if (!status.supported) {
    return <p className="text-xs text-muted">This copy does not update itself: {status.reason}.</p>;
  }

  const act = async (what: 'files' | 'rollback', call: () => Promise<UpdateStatus>) => {
    setBusy(what);
    try {
      await run(call);
    } finally {
      setBusy('');
      if (input.current) input.current.value = '';
    }
  };

  // "Back" to a version that is not newer than the running one: the one an
  // update replaced, or the running one itself while an update waits.
  const previous = status.previous;
  const back = previous && !isNewer(previous, appInfo.version);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        Without internet: download <code className="font-mono break-all">{status.asset}</code>, <code className="font-mono">SHA256SUMS.txt</code> and{' '}
        <code className="font-mono">SHA256SUMS.txt.sig</code> of the release on another machine and choose all three here. The release is installed only when
        the release key signed it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={e => {
            const files = [...(e.target.files ?? [])];
            if (files.length) act('files', () => api.installUpdateFiles(files));
          }}
        />
        <Button icon={<FolderOpen size={13} />} loading={busy === 'files'} disabled={!!busy} onClick={() => input.current?.click()}>
          Install from files…
        </Button>
        {previous && (
          <Button
            icon={<Undo2 size={13} />}
            loading={busy === 'rollback'}
            disabled={!!busy}
            onClick={() => act('rollback', api.rollbackUpdate)}
            title={`Puts ${previous} back in place, the version the last update replaced; this one is kept in its stead. Connections, settings and the history stay as they are.`}
          >
            {back ? 'Back to' : 'Switch to'} v{previous}
          </Button>
        )}
        {status.state === 'ready' && (
          <Button variant="primary" icon={<RotateCw size={13} />} loading={restarting} onClick={restart}>
            Restart for v{status.version}
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
