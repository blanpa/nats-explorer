import { Package, X } from 'lucide-react';
import { bundleApi, type OpenedBundle } from '../../lib/api.bundle';
import { errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { formatBytes, formatDateTime, formatNumber } from '../../lib/utils';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
import { confirm } from '../ui/Dialog';
import { EmptyState, ErrorState, LoadingState, PaneHeader, SectionTitle, StatStrip, StatTile } from '../ui/misc';
import { toast } from '../ui/Toast';

/** A number out of the saved varz, or a dash. */
function varzNumber(server: Record<string, unknown> | undefined, key: string): string {
  const varz = server?.varz as Record<string, unknown> | undefined;
  const v = varz?.[key];
  return typeof v === 'number' ? formatNumber(v) : '–';
}

/**
 * What an imported bundle contains. The Subjects module reads its messages
 * like any connection's; this view shows what has no live source: when it
 * was taken, from which server, and the snapshot of that moment.
 */
export default function BundleView({ connId }: { connId: string }) {
  const { data, error, initial, loading } = useAsync<OpenedBundle>(() => bundleApi.get(connId), [connId], { key: `bundle:${connId}` });
  const setModule = useStore(s => s.setModule);

  const close = async () => {
    if (
      !(await confirm({
        title: 'Close this bundle?',
        message: 'Its messages are dropped from this explorer. The file stays.',
        confirmLabel: 'Close bundle',
        danger: true,
      }))
    )
      return;
    try {
      await bundleApi.close(connId);
      setModule('subjects');
    } catch (err) {
      toast.error('Could not close the bundle', errorMessage(err));
    }
  };

  const header = (
    <PaneHeader title="Support bundle">
      <Button variant="outline" size="sm" icon={<X size={13} />} className="ml-auto" onClick={close}>
        Close bundle
      </Button>
    </PaneHeader>
  );

  if (initial && loading) {
    return (
      <div className="flex flex-col h-full">
        {header}
        <LoadingState />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex flex-col h-full">
        {header}
        <ErrorState title="Bundle not available" message={error ?? 'It may have been closed already.'} />
      </div>
    );
  }

  const { manifest, server, streams, kv } = data;
  const varz = server?.varz as Record<string, unknown> | undefined;

  return (
    <div className="flex flex-col h-full min-h-0">
      {header}
      <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Package size={14} className="text-accent" />
          <span className="font-medium">{manifest.connection.name || 'unnamed connection'}</span>
          <span className="text-muted text-xs">taken {formatDateTime(manifest.createdAt)}</span>
          {manifest.connection.servers?.length ? <span className="text-muted font-mono text-xs">{manifest.connection.servers.join(', ')}</span> : null}
          <span className="text-faint text-xs">explorer {manifest.explorerVersion}</span>
        </div>

        <StatStrip>
          <StatTile label="Messages" value={formatNumber(manifest.messages)} sub={`${formatNumber(manifest.subjects)} subjects`} />
          <StatTile
            label="Range"
            value={manifest.from ? formatDateTime(manifest.from) : 'memory'}
            sub={manifest.to && manifest.from ? `to ${formatDateTime(manifest.to)}` : undefined}
          />
          <StatTile label="Subject filter" value={manifest.subject || 'all'} />
          <StatTile label="Streams" value={formatNumber(streams?.length ?? 0)} />
          <StatTile label="KV buckets" value={formatNumber(kv?.length ?? 0)} />
        </StatStrip>

        {manifest.errors?.length ? (
          <div className="text-xs text-warn">
            {manifest.errors.length} endpoint(s) could not be read at export time: {manifest.errors.join('; ')}
          </div>
        ) : null}

        {varz && (
          <div>
            <SectionTitle>Server at export time</SectionTitle>
            <StatStrip>
              <StatTile label="Server" value={String(varz.server_name ?? '–')} sub={String(varz.version ?? '')} />
              <StatTile label="Connections" value={varzNumber(server, 'connections')} />
              <StatTile label="Subscriptions" value={varzNumber(server, 'subscriptions')} />
              <StatTile label="Slow consumers" value={varzNumber(server, 'slow_consumers')} />
              <StatTile label="Messages in / out" value={`${varzNumber(server, 'in_msgs')} / ${varzNumber(server, 'out_msgs')}`} />
              <StatTile label="Uptime" value={String(varz.uptime ?? '–')} />
            </StatStrip>
          </div>
        )}

        {streams?.length ? (
          <div>
            <SectionTitle>Streams</SectionTitle>
            <div className="card overflow-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Subjects</th>
                    <th className="num">Messages</th>
                    <th className="num">Size</th>
                    <th className="num">Consumers</th>
                  </tr>
                </thead>
                <tbody>
                  {streams.map(s => (
                    <tr key={s.name}>
                      <td className="font-mono">{s.name}</td>
                      <td className="font-mono text-muted truncate max-w-[280px]">{s.subjects?.join(', ') || '–'}</td>
                      <td className="num">{formatNumber(s.messages)}</td>
                      <td className="num">{formatBytes(s.bytes)}</td>
                      <td className="num">{formatNumber(s.consumers?.length ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyState compact title="No JetStream data" description="The server had no streams, or JetStream was not reachable at export time." />
        )}

        <p className="text-xs text-muted">The Subjects module reads the recorded messages of this bundle like those of a live connection.</p>
      </div>
    </div>
  );
}
