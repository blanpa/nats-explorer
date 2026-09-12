import { RefreshCw, Settings2 } from 'lucide-react';
import type { ClusterOverview as Overview } from 'shared';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useStore } from '../../store';
import { formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Badge, ErrorState, LoadingState, PaneHeader, SectionTitle, StatStrip, StatTile } from '../ui/misc';
import PeerChips from './PeerChips';
import ServersTable from './ServersTable';
import StreamsTable from './StreamsTable';

/** Every node of the cluster the active connection belongs to, plus the JetStream meta cluster and stream placement. */
export default function ClusterOverview({ connId }: { connId: string }) {
  const conn = useStore(s => s.connections.find(c => c.id === connId));
  const openConnections = useStore(s => s.openConnectionsDialog);
  const { data, error, loading, initial, reload } = useAsync<Overview>(
    () => (conn?.connected ? api.clusterOverview(connId) : null),
    [connId, conn?.connected],
    { key: `cluster:${connId}`, interval: 10_000 },
  );

  const header = (
    <PaneHeader title="Cluster">
      {conn && <span className="text-sm text-muted truncate">{conn.name}</span>}
      {data && (
        <Badge
          tone={data.source === 'system' ? 'ok' : 'warn'}
          title={
            data.source === 'system'
              ? 'Every server answered on the system account'
              : 'Only the connected server is visible; add system-account credentials to the connection'
          }
        >
          {data.source === 'system' ? 'system account' : 'single server view'}
        </Badge>
      )}
      <span className="ml-auto flex items-center gap-1">
        {data?.source !== 'system' && (
          <Button size="sm" variant="outline" icon={<Settings2 size={13} />} onClick={() => openConnections(connId)}>
            System account…
          </Button>
        )}
        <IconButton label="Refresh" size="sm" loading={loading && !initial} onClick={reload}>
          <RefreshCw size={14} />
        </IconButton>
      </span>
    </PaneHeader>
  );

  if (initial && loading)
    return (
      <>
        {header}
        <LoadingState />
      </>
    );
  if (error || !data)
    return (
      <>
        {header}
        <ErrorState title="Cannot load cluster overview" message={error ?? undefined} />
      </>
    );

  const metaSize = data.meta?.cluster_size ?? 0;
  // With one server the placement of every stream is that server: the column says nothing.
  const multiServer = (data?.servers.length ?? 0) > 1;
  const metaPeers = data.meta?.replicas ?? [];
  const offline = metaPeers.filter(p => p.offline).length;
  const totalConns = data.servers.reduce((s, x) => s + x.connections, 0);
  const totalStreams = data.streams.length;
  const unhealthy = data.streams.filter(s => s.peers.some(p => p.offline || !p.current)).length;

  return (
    <>
      {header}
      <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-5">
        {data.errors.map(e => (
          <div key={e} className="text-xs text-warn rounded border border-warn/30 bg-warn/5 px-3 py-2">
            {e}
          </div>
        ))}

        <StatStrip>
          <StatTile
            label="Servers"
            value={formatNumber(data.servers.length)}
            sub={data.servers[0]?.cluster ? `cluster ${data.servers[0].cluster}` : undefined}
          />
          <StatTile label="Client connections" value={formatNumber(totalConns)} />
          <StatTile
            label="JetStream meta"
            value={data.meta ? data.meta.leader || '–' : 'off'}
            sub={data.meta ? `${metaSize} peers${offline ? `, ${offline} offline` : ''}` : undefined}
            tone={offline > 0 ? 'danger' : data.meta ? 'ok' : undefined}
          />
          <StatTile
            label="Streams"
            value={formatNumber(totalStreams)}
            sub={unhealthy ? `${unhealthy} with lagging or offline replicas` : undefined}
            tone={unhealthy > 0 ? 'warn' : undefined}
          />
        </StatStrip>

        <ServersTable servers={data.servers} />

        {data.meta && (
          <div>
            <SectionTitle>
              JetStream meta cluster <span className="font-normal text-faint ml-1">{data.meta.name}</span>
            </SectionTitle>
            <PeerChips peers={metaPeers} leader={data.meta.leader} />
          </div>
        )}

        <StreamsTable streams={data.streams} multiServer={multiServer} />
      </div>
    </>
  );
}
