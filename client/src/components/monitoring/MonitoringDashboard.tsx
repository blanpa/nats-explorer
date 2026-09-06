import { useState } from 'react';
import { Activity, RefreshCw, Settings2 } from 'lucide-react';
import type { Connz, Healthz, Jsz, Leafz, Routez, Subsz, Varz } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useStore, useActiveConnection } from '../../store';
import { cn, formatBytes, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader, SectionTitle, Segmented, StatStrip, StatTile } from '../ui/misc';
import { RateChart } from '../ui/RateChart';
import { gaugeSeries, rateSeries, recordSample, samplesFor } from './history';

interface Snapshot {
  varz: Varz | null;
  jsz: Jsz | null;
  connz: Connz | null;
  subsz: Subsz | null;
  healthz: Healthz | null;
  routez: Routez | null;
  leafz: Leafz | null;
  errors: string[];
}

const COLORS = { in: 'rgb(var(--accent))', out: 'rgb(var(--info))', warn: 'rgb(var(--warn))', danger: 'rgb(var(--danger))' };
const perSec = (v: number) => `${v > 0 && v < 10 ? v.toFixed(1) : formatNumber(Math.round(v))}/s`;
const whole = (v: number) => formatNumber(Math.round(v));
const bytesPerSec = (v: number) => `${formatBytes(v)}/s`;

async function load(connId: string): Promise<Snapshot> {
  const [varz, jsz, connz, subsz, healthz, routez, leafz] = await Promise.allSettled([
    api.getMonitoring<Varz>(connId, 'varz'),
    api.getMonitoring<Jsz>(connId, 'jsz'),
    api.getMonitoring<Connz>(connId, 'connz', { limit: 200, sort: 'msgs_from' }),
    api.getMonitoring<Subsz>(connId, 'subsz'),
    api.getMonitoring<Healthz>(connId, 'healthz'),
    api.getMonitoring<Routez>(connId, 'routez'),
    api.getMonitoring<Leafz>(connId, 'leafz'),
  ]);
  const val = <T,>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null);
  const errors = [varz, jsz, connz, subsz, healthz, routez, leafz].filter(r => r.status === 'rejected').map(r => errorMessage((r as PromiseRejectedResult).reason));
  if (varz.status === 'rejected') throw varz.reason;
  recordSample(connId, varz.value, val(jsz));
  return { varz: val(varz), jsz: val(jsz), connz: val(connz), subsz: val(subsz), healthz: val(healthz), routez: val(routez), leafz: val(leafz), errors };
}

function Throughput({ connId }: { connId: string }) {
  const samples = samplesFor(connId);
  const msgsIn = rateSeries(samples, s => s.inMsgs);
  const msgsOut = rateSeries(samples, s => s.outMsgs);
  const bytesIn = rateSeries(samples, s => s.inBytes);
  const bytesOut = rateSeries(samples, s => s.outBytes);
  const conns = gaugeSeries(samples, s => s.connections);
  const subs = gaugeSeries(samples, s => s.subscriptions);
  const cpu = gaugeSeries(samples, s => s.cpu);
  const api = rateSeries(samples, s => s.jsApiTotal);
  const apiErr = rateSeries(samples, s => s.jsApiErrors);
  const slow = gaugeSeries(samples, s => s.slowConsumers);
  const span = samples.length > 1 ? Math.round((samples[samples.length - 1].t - samples[0].t) / 60000) : 0;
  return (
    <div>
      <SectionTitle>
        Throughput
        {span > 0 && <span className="font-normal text-faint ml-2">last {span < 1 ? '<1' : span} min</span>}
      </SectionTitle>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-4">
        <RateChart title="Messages per second" times={msgsIn.times} series={[{ label: 'in', color: COLORS.in, values: msgsIn.values }, { label: 'out', color: COLORS.out, values: msgsOut.values }]} format={perSec} />
        <RateChart title="Bytes per second" times={bytesIn.times} series={[{ label: 'in', color: COLORS.in, values: bytesIn.values }, { label: 'out', color: COLORS.out, values: bytesOut.values }]} format={bytesPerSec} />
        <RateChart title="JetStream API" times={api.times} series={[{ label: 'calls', color: COLORS.in, values: api.values }, { label: 'errors', color: COLORS.danger, values: apiErr.values }]} format={perSec} />
        <RateChart title="Client connections" times={conns.times} series={[{ label: 'clients', color: COLORS.in, values: conns.values }, { label: 'slow', color: COLORS.warn, values: slow.values }]} format={whole} />
        <RateChart title="Subscriptions" times={subs.times} series={[{ label: 'total', color: COLORS.out, values: subs.values }]} format={whole} />
        <RateChart title="CPU" times={cpu.times} series={[{ label: 'cpu', color: COLORS.warn, values: cpu.values }]} format={v => `${v.toFixed(1)}%`} />
      </div>
    </div>
  );
}

/** nats-server 2.10+ opens a pool of route connections per peer; show one row per peer with the pool summed up. */
function groupRoutes(routes: Routez['routes']) {
  const byPeer = new Map<string, { name: string; addr: string; rtt?: string; subs: number; inMsgs: number; outMsgs: number; inBytes: number; outBytes: number; pending: number; count: number }>();
  for (const r of routes) {
    const name = r.remote_name || r.remote_id.slice(0, 12);
    const g = byPeer.get(name) ?? { name, addr: r.ip, rtt: r.rtt, subs: 0, inMsgs: 0, outMsgs: 0, inBytes: 0, outBytes: 0, pending: 0, count: 0 };
    g.count++;
    g.subs += r.subscriptions ?? 0;
    g.inMsgs += r.in_msgs ?? 0;
    g.outMsgs += r.out_msgs ?? 0;
    g.inBytes += r.in_bytes ?? 0;
    g.outBytes += r.out_bytes ?? 0;
    g.pending += r.pending_size ?? 0;
    byPeer.set(name, g);
  }
  return [...byPeer.values()].map(g => ({
    key: g.name,
    name: g.name,
    addr: g.addr,
    rtt: g.rtt,
    subs: g.subs,
    inMsgs: g.inMsgs,
    outMsgs: g.outMsgs,
    inBytes: g.inBytes,
    outBytes: g.outBytes,
    extra: [g.count > 1 ? `${g.count} connections` : undefined, g.pending ? `${formatBytes(g.pending)} pending` : undefined].filter(Boolean).join(' · ') || undefined,
  }));
}

function PeerTable({ title, rows }: { title: string; rows: { key: string; name: string; addr: string; rtt?: string; inMsgs?: number; outMsgs?: number; inBytes?: number; outBytes?: number; subs?: number; extra?: string }[] }) {
  return (
    <div>
      <SectionTitle>
        {title} · {rows.length}
      </SectionTitle>
      <div className="card overflow-auto">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Address</th>
              <th>RTT</th>
              <th className="num">Subs</th>
              <th className="num">Msgs in</th>
              <th className="num">Msgs out</th>
              <th className="num">Bytes in</th>
              <th className="num">Bytes out</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td className="font-medium">
                  {r.name}
                  {r.extra && <span className="ml-2 text-xs text-muted">{r.extra}</span>}
                </td>
                <td className="font-mono text-muted">{r.addr}</td>
                <td className="font-mono text-muted">{r.rtt || '–'}</td>
                <td className="num">{r.subs !== undefined ? formatNumber(r.subs) : '–'}</td>
                <td className="num">{r.inMsgs !== undefined ? formatNumber(r.inMsgs) : '–'}</td>
                <td className="num">{r.outMsgs !== undefined ? formatNumber(r.outMsgs) : '–'}</td>
                <td className="num">{r.inBytes !== undefined ? formatBytes(r.inBytes) : '–'}</td>
                <td className="num">{r.outBytes !== undefined ? formatBytes(r.outBytes) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
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
  const { data, error, loading, initial, reload } = useAsync<Snapshot>(() => (connId ? load(connId) : null), [connId], { key: `mon:${connId}`, interval: interval || undefined });

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

  const { varz, jsz, connz, subsz, healthz, routez, leafz } = data;
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

        <StatStrip>
          <StatTile label="CPU" value={`${(varz.cpu ?? 0).toFixed(1)}%`} sub={`${varz.cores} cores`} tone={varz.cpu > 80 ? 'warn' : undefined} />
          <StatTile label="Memory" value={formatBytes(varz.mem)} />
          <StatTile label="Connections" value={formatNumber(varz.connections)} sub={`${formatNumber(varz.total_connections)} total`} />
          <StatTile label="Subscriptions" value={formatNumber(varz.subscriptions)} />
          <StatTile label="Slow consumers" value={formatNumber(varz.slow_consumers)} tone={varz.slow_consumers > 0 ? 'warn' : undefined} />
          <StatTile label="Messages in / out" value={`${formatNumber(varz.in_msgs)} / ${formatNumber(varz.out_msgs)}`} />
          <StatTile label="Bytes in / out" value={`${formatBytes(varz.in_bytes)} / ${formatBytes(varz.out_bytes)}`} />
          <StatTile label="Routes / Leaf" value={`${varz.routes ?? 0} / ${varz.leafnodes ?? 0}`} />
        </StatStrip>

        <Throughput connId={connId} />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="flex flex-col gap-3">
            <SectionTitle className="mb-0">JetStream</SectionTitle>
            {jsz ? (
              <>
                <UsageBar label="Memory" used={jsz.memory} max={jsz.config?.max_memory ?? 0} />
                <UsageBar label="Storage" used={jsz.storage} max={jsz.config?.max_storage ?? 0} />
                <StatStrip>
                  <StatTile label="Streams" value={formatNumber(jsz.streams)} />
                  <StatTile label="Consumers" value={formatNumber(jsz.consumers)} />
                  <StatTile label="Messages" value={formatNumber(jsz.messages)} sub={formatBytes(jsz.bytes)} />
                  <StatTile label="API calls" value={formatNumber(jsz.api?.total ?? 0)} sub={`${formatNumber(jsz.api?.errors ?? 0)} errors`} tone={(jsz.api?.errors ?? 0) > 0 ? 'warn' : undefined} />
                </StatStrip>
              </>
            ) : (
              <div className="text-sm text-muted">JetStream is not enabled on this server.</div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <SectionTitle className="mb-0">Subscriptions</SectionTitle>
            {subsz ? (
              <StatStrip>
                <StatTile label="Total" value={formatNumber(subsz.num_subscriptions)} />
                <StatTile label="Cache hit rate" value={`${((subsz.cache_hit_rate ?? 0) * 100).toFixed(1)}%`} />
                <StatTile label="Max fan-out" value={formatNumber(subsz.max_fanout)} />
                <StatTile label="Avg fan-out" value={(subsz.avg_fanout ?? 0).toFixed(2)} />
              </StatStrip>
            ) : (
              <div className="text-sm text-muted">Not available.</div>
            )}
          </div>
        </div>

        {routez && routez.num_routes > 0 && <PeerTable title="Cluster routes" rows={groupRoutes(routez.routes)} />}
        {leafz && leafz.leafnodes > 0 && (
          <PeerTable
            title="Leaf nodes"
            rows={leafz.leafs.map((l, i) => ({ key: `${l.ip}:${l.port}:${i}`, name: l.name || `leaf ${i + 1}`, addr: `${l.ip}:${l.port}`, rtt: l.rtt, subs: l.subscriptions, inMsgs: l.in_msgs, outMsgs: l.out_msgs, inBytes: l.in_bytes, outBytes: l.out_bytes, extra: [l.account, l.is_spoke ? 'spoke' : undefined].filter(Boolean).join(' · ') || undefined }))}
          />
        )}

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
