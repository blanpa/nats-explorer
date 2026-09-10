import { useState } from 'react';
import { Activity, Package, RefreshCw, Settings2 } from 'lucide-react';
import { useAsync } from '../../lib/useAsync';
import { useStore, useActiveConnection } from '../../store';
import { formatBytes, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader, SectionTitle, Segmented, StatStrip, StatTile } from '../ui/misc';
import { ServerName } from '../ui/ServerName';
import ConnectionsTable from './ConnectionsTable';
import PeerTable, { groupRoutes } from './PeerTable';
import BundleView from '../bundle/BundleView';
import ExportBundleDialog from '../bundle/ExportBundleDialog';
import { loadSnapshot, type Snapshot } from './snapshot';
import Throughput from './Throughput';
import UsageBar from './UsageBar';

type Interval = 0 | 5000 | 15000;

export default function MonitoringDashboard() {
  const connId = useStore(s => s.activeConnId);
  const conn = useActiveConnection();
  const openConnections = useStore(s => s.openConnectionsDialog);
  const [interval, setInterval_] = useState<Interval>(5000);
  const [exporting, setExporting] = useState(false);
  const { data, error, loading, initial, reload } = useAsync<Snapshot>(() => (connId ? loadSnapshot(connId) : null), [connId], {
    key: `mon:${connId}`,
    interval: interval || undefined,
  });

  if (!connId) return <EmptyState icon={Activity} title="No connection selected" />;
  // A bundle has no server to poll; it carries the snapshot of its export.
  if (conn?.bundle) return <BundleView connId={connId} />;

  const bundleDialog = exporting && connId ? <ExportBundleDialog connId={connId} onClose={() => setExporting(false)} /> : null;

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
          <IconButton label="Export support bundle" onClick={() => setExporting(true)}>
            <Package size={14} />
          </IconButton>
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
        {bundleDialog}
        <LoadingState />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="flex flex-col h-full">
        {header}
        {bundleDialog}
        <ErrorState
          title="Monitoring endpoint not reachable"
          message={error}
          action={
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm text-muted max-w-[420px]">
                NATS exposes monitoring over HTTP when started with <code className="text-fg">--http_port 8222</code>. Set the monitoring URL in the connection
                settings if it runs on a different host or port.
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
      {bundleDialog}
      {/*
        The page answers four questions in the order they are asked: is this
        server well, what is it carrying, what is inside JetStream, and who
        is talking to it. Each answer is a titled card, the shape the tables
        below already had -- before, the strips and sections were loose rows
        and the page read as one long ribbon with no grouping in it.
      */}
      <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-5">
        <div className="card px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Badge tone={healthz ? (healthy ? 'ok' : 'danger') : 'neutral'}>
            {healthz ? (healthy ? 'healthy' : healthz.error || healthz.status) : 'health unknown'}
          </Badge>
          <ServerName name={varz.server_name} className="font-medium" />
          <span className="text-muted font-mono text-xs">
            v{varz.version} · {varz.go} · {varz.host}:{varz.port}
          </span>
          {data.errors.length > 0 && (
            <span className="text-xs text-warn" title={data.errors.join('\n')}>
              {data.errors.length} endpoint{data.errors.length === 1 ? '' : 's'} did not answer
            </span>
          )}
          <span className="ml-auto text-xs text-muted font-mono tabular-nums">up {varz.uptime}</span>
        </div>

        <div>
          <SectionTitle>Overview</SectionTitle>
          {/* Load first, then who is attached, then how much has gone
              through, then what it is attached to. The cumulative totals sit
              at the end: they are the least useful figure on the page and
              they used to lead it. */}
          <div className="card px-3 py-2">
            <StatStrip>
              <StatTile label="CPU" value={`${(varz.cpu ?? 0).toFixed(1)}%`} sub={`${varz.cores} cores`} tone={varz.cpu > 80 ? 'warn' : undefined} />
              <StatTile label="Memory" value={formatBytes(varz.mem)} />
              <StatTile label="Slow consumers" value={formatNumber(varz.slow_consumers)} tone={varz.slow_consumers > 0 ? 'warn' : undefined} />
              <StatTile label="Connections" value={formatNumber(varz.connections)} sub={`${formatNumber(varz.total_connections)} total`} />
              <StatTile label="Subscriptions" value={formatNumber(varz.subscriptions)} />
              <StatTile label="Routes" value={formatNumber(varz.routes ?? 0)} />
              <StatTile label="Leaf nodes" value={formatNumber(varz.leafnodes ?? 0)} />
              <StatTile label="Messages in / out" value={`${formatNumber(varz.in_msgs)} / ${formatNumber(varz.out_msgs)}`} sub="since start" />
              <StatTile label="Bytes in / out" value={`${formatBytes(varz.in_bytes)} / ${formatBytes(varz.out_bytes)}`} sub="since start" />
            </StatStrip>
          </div>
        </div>

        <Throughput connId={connId} />

        {/* JetStream is wide because its bars are; the subscription figures
            fill the space beside it that the bars used to leave empty. */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 items-start">
          <div className="xl:col-span-2">
            <SectionTitle>JetStream</SectionTitle>
            <div className="card px-3 py-2">
              {jsz ? (
                <div className="flex flex-col gap-3">
                  <StatStrip>
                    <StatTile label="Streams" value={formatNumber(jsz.streams)} />
                    <StatTile label="Consumers" value={formatNumber(jsz.consumers)} />
                    <StatTile label="Messages" value={formatNumber(jsz.messages)} sub={formatBytes(jsz.bytes)} />
                    <StatTile
                      label="API calls"
                      value={formatNumber(jsz.api?.total ?? 0)}
                      sub={`${formatNumber(jsz.api?.errors ?? 0)} errors`}
                      tone={(jsz.api?.errors ?? 0) > 0 ? 'warn' : undefined}
                    />
                  </StatStrip>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                    <UsageBar label="Memory" used={jsz.memory} max={jsz.config?.max_memory ?? 0} />
                    <UsageBar label="Storage" used={jsz.storage} max={jsz.config?.max_storage ?? 0} />
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted">JetStream is not enabled on this server.</div>
              )}
            </div>
          </div>

          <div>
            <SectionTitle>Subscription routing</SectionTitle>
            <div className="card px-3 py-2">
              {subsz ? (
                <StatStrip>
                  <StatTile label="Cache hit rate" value={`${((subsz.cache_hit_rate ?? 0) * 100).toFixed(1)}%`} />
                  <StatTile label="Max fan-out" value={formatNumber(subsz.max_fanout)} />
                  <StatTile label="Avg fan-out" value={(subsz.avg_fanout ?? 0).toFixed(2)} />
                </StatStrip>
              ) : (
                <div className="text-sm text-muted">Not available.</div>
              )}
            </div>
          </div>
        </div>

        {routez && routez.num_routes > 0 && <PeerTable title="Cluster routes" rows={groupRoutes(routez.routes)} />}
        {leafz && leafz.leafnodes > 0 && (
          <PeerTable
            title="Leaf nodes"
            rows={leafz.leafs.map((l, i) => ({
              key: `${l.ip}:${l.port}:${i}`,
              name: l.name || `leaf ${i + 1}`,
              addr: `${l.ip}:${l.port}`,
              rtt: l.rtt,
              subs: l.subscriptions,
              inMsgs: l.in_msgs,
              outMsgs: l.out_msgs,
              inBytes: l.in_bytes,
              outBytes: l.out_bytes,
              extra: [l.account, l.is_spoke ? 'spoke' : undefined].filter(Boolean).join(' · ') || undefined,
            }))}
          />
        )}

        {connz && <ConnectionsTable connz={connz} />}
      </div>
    </div>
  );
}
