import { useState } from 'react';
import { Activity, RefreshCw, Settings2 } from 'lucide-react';
import type { Connz, Healthz, Jsz, Routez, Subsz, Varz } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useStore, useActiveConnection } from '../../store';
import { cn, formatBytes, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader, SectionTitle, Segmented, StatTile } from '../ui/misc';

interface Snapshot {
  varz: Varz | null;
  jsz: Jsz | null;
  connz: Connz | null;
  subsz: Subsz | null;
  healthz: Healthz | null;
  routez: Routez | null;
  errors: string[];
}

async function load(connId: string): Promise<Snapshot> {
  const [varz, jsz, connz, subsz, healthz, routez] = await Promise.allSettled([
    api.getMonitoring<Varz>(connId, 'varz'),
    api.getMonitoring<Jsz>(connId, 'jsz'),
    api.getMonitoring<Connz>(connId, 'connz', { limit: 200, sort: 'msgs_from' }),
    api.getMonitoring<Subsz>(connId, 'subsz'),
    api.getMonitoring<Healthz>(connId, 'healthz'),
    api.getMonitoring<Routez>(connId, 'routez'),
  ]);
  const val = <T,>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null);
  const errors = [varz, jsz, connz, subsz, healthz, routez].filter(r => r.status === 'rejected').map(r => errorMessage((r as PromiseRejectedResult).reason));
  if (varz.status === 'rejected') throw varz.reason;
  return { varz: val(varz), jsz: val(jsz), connz: val(connz), subsz: val(subsz), healthz: val(healthz), routez: val(routez), errors };
}

function UsageBar({ used, max, label }: { used: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="text-muted">{label}</span>
        <span className="font-mono tabular-nums">
          {formatBytes(used)} <span className="text-faint">/ {max > 0 ? formatBytes(max) : '∞'}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-field overflow-hidden">
        <div className={cn('h-full rounded-full', pct > 90 ? 'bg-danger' : pct > 70 ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

type Interval = 0 | 5000 | 15000;

export default function MonitoringDashboard() {
  const connId = useStore(s => s.activeConnId);
  const conn = useActiveConnection();
  const openConnections = useStore(s => s.openConnectionsDialog);
  const [interval, setInterval_] = useState<Interval>(5000);
  const { data, error, loading, initial, reload } = useAsync<Snapshot>(() => (connId ? load(connId) : null), [connId], { interval: interval || undefined });

  if (!connId) return <EmptyState icon={Activity} title="No connection selected" />;

  const header = (
    <PaneHeader
      title="Server monitoring"
      actions={
        <>
          <Segmented
            size="xs"
            value={String(interval)}
            onChange={v => setInterval_(Number(v) as Interval)}
            options={[
              { id: '0', label: 'Manual' },
              { id: '5000', label: '5s' },
              { id: '15000', label: '15s' },
            ]}
          />
          <IconButton label="Refresh" loading={loading && !initial} onClick={reload}>
            <RefreshCw size={14} />
          </IconButton>
        </>
      }
    >
      {conn && <span className="text-sm text-muted truncate">{conn.name}</span>}
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
  if (error && !data) {
    return (
      <div className="flex flex-col h-full">
        {header}
        <ErrorState
          title="Monitoring endpoint not reachable"
          message={error}
          action={
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm text-muted max-w-[420px]">
                NATS exposes monitoring over HTTP when started with <code className="text-fg">--http_port 8222</code>. Set the monitoring URL in the connection settings if it runs on a different host or port.
              </p>
              <div className="flex gap-2">
                <Button onClick={reload}>Retry</Button>
                <Button variant="outline" icon={<Settings2 size={13} />} onClick={() => openConnections(connId)}>
                  Connection settings
                </Button>
              </div>
            </div>
          }
        />
      </div>
    );
  }
  if (!data?.varz) return null;

  const { varz, jsz, connz, subsz, healthz, routez } = data;
  const healthy = healthz?.status === 'ok';

  return (
    <div className="flex flex-col h-full min-h-0">
      {header}
      <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={healthz ? (healthy ? 'ok' : 'danger') : 'neutral'}>{healthz ? (healthy ? 'healthy' : healthz.error || healthz.status) : 'health unknown'}</Badge>
          <span className="font-medium">{varz.server_name}</span>
          <span className="text-muted font-mono">v{varz.version}</span>
          <span className="text-muted font-mono">{varz.go}</span>
          <span className="text-muted">up {varz.uptime}</span>
          <span className="text-muted font-mono">
            {varz.host}:{varz.port}
          </span>
          {data.errors.length > 0 && <span className="text-xs text-warn ml-auto">{data.errors.length} endpoint(s) failed</span>}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
          <StatTile label="CPU" value={`${(varz.cpu ?? 0).toFixed(1)}%`} sub={`${varz.cores} cores`} tone={varz.cpu > 80 ? 'warn' : undefined} />
          <StatTile label="Memory" value={formatBytes(varz.mem)} />
          <StatTile label="Connections" value={formatNumber(varz.connections)} sub={`${formatNumber(varz.total_connections)} total`} />
          <StatTile label="Subscriptions" value={formatNumber(varz.subscriptions)} />
          <StatTile label="Slow consumers" value={formatNumber(varz.slow_consumers)} tone={varz.slow_consumers > 0 ? 'warn' : undefined} />
          <StatTile label="Messages in / out" value={`${formatNumber(varz.in_msgs)} / ${formatNumber(varz.out_msgs)}`} className="[&>div:nth-child(2)]:text-md" />
          <StatTile label="Bytes in / out" value={`${formatBytes(varz.in_bytes)} / ${formatBytes(varz.out_bytes)}`} className="[&>div:nth-child(2)]:text-md" />
          <StatTile label="Routes / Leaf" value={`${varz.routes ?? 0} / ${varz.leafnodes ?? 0}`} />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="card p-4 flex flex-col gap-3">
            <SectionTitle className="mb-0">JetStream</SectionTitle>
            {jsz ? (
              <>
                <UsageBar label="Memory" used={jsz.memory} max={jsz.config?.max_memory ?? 0} />
                <UsageBar label="Storage" used={jsz.storage} max={jsz.config?.max_storage ?? 0} />
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-1">
                  <StatTile label="Streams" value={formatNumber(jsz.streams)} className="bg-panel" />
                  <StatTile label="Consumers" value={formatNumber(jsz.consumers)} className="bg-panel" />
                  <StatTile label="Messages" value={formatNumber(jsz.messages)} sub={formatBytes(jsz.bytes)} className="bg-panel" />
                  <StatTile label="API calls" value={formatNumber(jsz.api?.total ?? 0)} sub={`${formatNumber(jsz.api?.errors ?? 0)} errors`} tone={(jsz.api?.errors ?? 0) > 0 ? 'warn' : undefined} className="bg-panel" />
                </div>
              </>
            ) : (
              <div className="text-sm text-muted">JetStream is not enabled on this server.</div>
            )}
          </div>

          <div className="card p-4 flex flex-col gap-3">
            <SectionTitle className="mb-0">Subscriptions</SectionTitle>
            {subsz ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatTile label="Total" value={formatNumber(subsz.num_subscriptions)} className="bg-panel" />
                <StatTile label="Cache hit rate" value={`${((subsz.cache_hit_rate ?? 0) * 100).toFixed(1)}%`} className="bg-panel" />
                <StatTile label="Max fan-out" value={formatNumber(subsz.max_fanout)} className="bg-panel" />
                <StatTile label="Avg fan-out" value={(subsz.avg_fanout ?? 0).toFixed(2)} className="bg-panel" />
              </div>
            ) : (
              <div className="text-sm text-muted">Not available.</div>
            )}
            {routez && routez.num_routes > 0 && (
              <div className="pt-1">
                <div className="text-xs text-muted mb-1">Routes · {routez.num_routes}</div>
                <div className="flex flex-wrap gap-1">
                  {routez.routes.map(r => (
                    <Badge key={r.rid} tone="neutral" mono title={r.remote_id}>
                      {r.remote_name || r.remote_id.slice(0, 8)} · {r.ip}:{r.port}
                      {r.rtt ? ` · ${r.rtt}` : ''}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {connz && (
          <div>
            <SectionTitle>
              Client connections · {formatNumber(connz.num_connections)}
              {connz.total > connz.num_connections ? ` of ${formatNumber(connz.total)}` : ''}
            </SectionTitle>
            <div className="card overflow-auto max-h-[480px]">
              <table className="table">
                <thead>
                  <tr>
                    <th className="num">CID</th>
                    <th>Name</th>
                    <th>Address</th>
                    <th>Client</th>
                    <th className="num">Subs</th>
                    <th className="num">Msgs in</th>
                    <th className="num">Msgs out</th>
                    <th className="num">Bytes in</th>
                    <th className="num">Bytes out</th>
                    <th>RTT</th>
                    <th>Uptime</th>
                    <th>Idle</th>
                  </tr>
                </thead>
                <tbody>
                  {connz.connections.map(c => (
                    <tr key={c.cid}>
                      <td className="num text-muted">{c.cid}</td>
                      <td className="max-w-[200px] truncate">{c.name || <span className="text-faint">–</span>}</td>
                      <td className="font-mono text-muted">
                        {c.ip}:{c.port}
                      </td>
                      <td className="text-muted">
                        {c.lang} {c.version}
                      </td>
                      <td className="num">{formatNumber(c.subscriptions)}</td>
                      <td className="num">{formatNumber(c.in_msgs)}</td>
                      <td className="num">{formatNumber(c.out_msgs)}</td>
                      <td className="num">{formatBytes(c.in_bytes)}</td>
                      <td className="num">{formatBytes(c.out_bytes)}</td>
                      <td className="font-mono text-muted">{c.rtt || '–'}</td>
                      <td className="font-mono text-muted">{c.uptime}</td>
                      <td className="font-mono text-muted">{c.idle}</td>
                    </tr>
                  ))}
                  {connz.connections.length === 0 && (
                    <tr>
                      <td colSpan={12} className="text-center text-muted py-4">
                        No client connections
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
