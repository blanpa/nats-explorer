import { RefreshCw, Settings2 } from 'lucide-react';
import type { ClusterOverview as Overview, ClusterPeer } from 'shared';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useStore } from '../../store';
import { cn, formatBytes, formatDateTime, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Badge, ErrorState, LoadingState, PaneHeader, SectionTitle, StatStrip, StatTile } from '../ui/misc';

function uptime(start?: string): string {
  if (!start) return '–';
  const s = Math.max(0, Math.round((Date.now() - new Date(start).getTime()) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Leader first, then the replicas as reported (the leader is not part of its own replica list). */
function PeerChips({ peers, leader }: { peers: ClusterPeer[]; leader?: string }) {
  const all = leader && !peers.some(p => p.name === leader) ? [{ name: leader, current: true, offline: false, active: 0, lag: 0 }, ...peers] : peers;
  if (all.length === 0) return <span className="text-faint">–</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {all.map(p => (
        <Badge key={p.name} mono tone={p.offline ? 'danger' : !p.current ? 'warn' : p.name === leader ? 'accent' : 'neutral'} title={`${p.name}: ${p.offline ? 'offline' : p.current ? 'current' : 'catching up'}${p.lag ? `, lag ${formatNumber(p.lag)}` : ''}`}>
          {p.name}
          {p.name === leader ? ' ★' : ''}
          {p.lag > 0 ? ` +${formatNumber(p.lag)}` : ''}
        </Badge>
      ))}
    </span>
  );
}

/** Every node of the cluster the active connection belongs to, plus the JetStream meta cluster and stream placement. */
export default function ClusterOverview({ connId }: { connId: string }) {
  const conn = useStore(s => s.connections.find(c => c.id === connId));
  const openConnections = useStore(s => s.openConnectionsDialog);
  const { data, error, loading, initial, reload } = useAsync<Overview>(() => (conn?.connected ? api.clusterOverview(connId) : null), [connId, conn?.connected], { key: `cluster:${connId}`, interval: 10_000 });

  const header = (
    <PaneHeader title="Cluster">
      {conn && <span className="text-sm text-muted truncate">{conn.name}</span>}
      {data && (
        <Badge tone={data.source === 'system' ? 'ok' : 'warn'} title={data.source === 'system' ? 'Every server answered on the system account' : 'Only the connected server is visible; add system-account credentials to the connection'}>
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

  if (initial && loading) return <>{header}<LoadingState /></>;
  if (error || !data) return <>{header}<ErrorState title="Cannot load cluster overview" message={error ?? undefined} /></>;

  const metaSize = data.meta?.cluster_size ?? 0;
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
          <StatTile label="Servers" value={formatNumber(data.servers.length)} sub={data.servers[0]?.cluster ? `cluster ${data.servers[0].cluster}` : undefined} />
          <StatTile label="Client connections" value={formatNumber(totalConns)} />
          <StatTile label="JetStream meta" value={data.meta ? data.meta.leader || '–' : 'off'} sub={data.meta ? `${metaSize} peers${offline ? `, ${offline} offline` : ''}` : undefined} tone={offline > 0 ? 'danger' : data.meta ? 'ok' : undefined} />
          <StatTile label="Streams" value={formatNumber(totalStreams)} sub={unhealthy ? `${unhealthy} with lagging or offline replicas` : undefined} tone={unhealthy > 0 ? 'warn' : undefined} />
        </StatStrip>

        <div>
          <SectionTitle>Servers · {data.servers.length}</SectionTitle>
          <div className="card overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Version</th>
                  <th>Host</th>
                  <th>Up</th>
                  <th className="num">CPU</th>
                  <th className="num">Memory</th>
                  <th className="num">Conns</th>
                  <th className="num">Subs</th>
                  <th className="num">Slow</th>
                  <th className="num">Msgs in</th>
                  <th className="num">Msgs out</th>
                  <th className="num">Routes</th>
                  <th>JetStream</th>
                </tr>
              </thead>
              <tbody>
                {data.servers.map(s => (
                  <tr key={s.id || s.name}>
                    <td className="font-medium">
                      {s.name}
                      {s.metaLeader && (
                        <Badge tone="accent" className="ml-2" title="JetStream meta leader">
                          leader
                        </Badge>
                      )}
                    </td>
                    <td className="font-mono text-muted">{s.version}</td>
                    <td className="font-mono text-muted">{s.host && s.host !== '0.0.0.0' ? s.host : <span className="text-faint">–</span>}</td>
                    <td className="font-mono text-muted" title={s.start ? formatDateTime(new Date(s.start).getTime()) : undefined}>
                      {uptime(s.start)}
                    </td>
                    <td className={cn('num', s.cpu > 80 && 'text-warn')}>{s.cpu.toFixed(1)}%</td>
                    <td className="num">{formatBytes(s.mem)}</td>
                    <td className="num">{formatNumber(s.connections)}</td>
                    <td className="num">{formatNumber(s.subscriptions)}</td>
                    <td className={cn('num', s.slowConsumers > 0 && 'text-warn')}>{formatNumber(s.slowConsumers)}</td>
                    <td className="num">{formatNumber(s.inMsgs)}</td>
                    <td className="num">{formatNumber(s.outMsgs)}</td>
                    <td className="num">{s.routes}</td>
                    <td className="text-muted">
                      {s.jetstream && s.js ? `${formatNumber(s.js.streams)} streams · ${formatBytes(s.js.storage)} disk · ${formatBytes(s.js.memory)} mem` : s.jetstream ? 'enabled' : <span className="text-faint">off</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {data.meta && (
          <div>
            <SectionTitle>
              JetStream meta cluster <span className="font-normal text-faint ml-1">{data.meta.name}</span>
            </SectionTitle>
            <PeerChips peers={metaPeers} leader={data.meta.leader} />
          </div>
        )}

        <div>
          <SectionTitle>Streams · {data.streams.length}</SectionTitle>
          {data.streams.length === 0 ? (
            <div className="text-sm text-muted">No streams.</div>
          ) : (
            <div className="card overflow-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Stream</th>
                    <th>Account</th>
                    <th>Storage</th>
                    <th className="num">Replicas</th>
                    <th>Leader</th>
                    <th>Placement</th>
                    <th className="num">Messages</th>
                    <th className="num">Size</th>
                    <th className="num">Consumers</th>
                  </tr>
                </thead>
                <tbody>
                  {data.streams.map(s => (
                    <tr key={`${s.account}/${s.name}`}>
                      <td className="font-mono">{s.name}</td>
                      <td className="text-muted">{s.account}</td>
                      <td className="text-muted">{s.storage || '–'}</td>
                      <td className="num">{s.replicas || 1}</td>
                      <td className="font-mono">{s.leader || <span className="text-faint">–</span>}</td>
                      <td>
                        <PeerChips peers={s.peers ?? []} leader={s.leader} />
                      </td>
                      <td className="num">{formatNumber(s.messages)}</td>
                      <td className="num">{formatBytes(s.bytes)}</td>
                      <td className="num">{formatNumber(s.consumers)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
