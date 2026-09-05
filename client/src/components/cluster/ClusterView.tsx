import { RefreshCw, Server } from 'lucide-react';
import type { ConnectionStatus, ServerInfo } from 'shared';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useStore } from '../../store';
import { formatBytes, formatDurationMs, formatDateTime, formatNumber } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { Badge, EmptyState, ErrorState, KeyValueGrid, LoadingState, PaneHeader, SectionTitle, StatTile } from '../ui/misc';

function ServerCard({ conn }: { conn: ConnectionStatus }) {
  const { data, error, loading, initial, reload } = useAsync<ServerInfo>(() => (conn.connected ? api.getServerInfo(conn.id) : null), [conn.id, conn.connected], { interval: 10_000 });

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-line" style={{ boxShadow: `inset 3px 0 0 ${conn.color}` }}>
        <span className="font-semibold">{conn.name}</span>
        {data && <span className="text-xs text-muted font-mono">v{data.version}</span>}
        {data?.cluster && <Badge tone="accent">cluster {data.cluster}</Badge>}
        <Badge tone={conn.connected ? 'ok' : conn.reconnecting ? 'warn' : 'danger'}>{conn.connected ? 'connected' : conn.reconnecting ? 'reconnecting' : 'disconnected'}</Badge>
        <span className="ml-auto">
          <IconButton label="Refresh" size="xs" loading={loading && !initial} onClick={reload}>
            <RefreshCw size={13} />
          </IconButton>
        </span>
      </div>

      {!conn.connected ? (
        <div className="p-4 text-sm text-muted">{conn.lastError || 'Not connected.'}</div>
      ) : initial && loading ? (
        <LoadingState />
      ) : error || !data ? (
        <ErrorState title="Cannot read server info" message={error ?? undefined} />
      ) : (
        <div className="p-4 flex flex-col gap-5">
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <StatTile label="RTT" value={formatDurationMs(data.rttMs)} />
            <StatTile label="Max payload" value={formatBytes(data.maxPayload)} />
            <StatTile label="JetStream" value={data.jetstream ? 'enabled' : 'off'} tone={data.jetstream ? 'ok' : undefined} sub={data.jetstreamErr && !data.jetstream ? data.jetstreamErr : undefined} className="[&>div:nth-child(2)]:text-md" />
            <StatTile label="Msgs in / out" value={`${formatNumber(data.stats.inMsgs)} / ${formatNumber(data.stats.outMsgs)}`} sub="this client" className="[&>div:nth-child(2)]:text-md" />
            <StatTile label="Bytes in / out" value={`${formatBytes(data.stats.inBytes)} / ${formatBytes(data.stats.outBytes)}`} sub="this client" className="[&>div:nth-child(2)]:text-md" />
            <StatTile label="Reconnects" value={data.stats.reconnects} tone={data.stats.reconnects > 0 ? 'warn' : undefined} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <div>
              <SectionTitle>Server</SectionTitle>
              <KeyValueGrid
                columns={1}
                items={[
                  { label: 'Name', value: data.serverName, mono: true },
                  { label: 'ID', value: data.serverId, mono: true },
                  { label: 'Version', value: data.version, mono: true },
                  { label: 'Connected URL', value: data.url, mono: true },
                  { label: 'Address', value: data.addr, mono: true },
                  { label: 'Cluster', value: data.cluster || '–' },
                  { label: 'Headers', value: data.headers ? 'supported' : 'not supported' },
                  { label: 'Auth required', value: data.authRequired ? 'yes' : 'no' },
                  { label: 'TLS required', value: data.tlsRequired ? 'yes' : 'no' },
                ]}
              />
            </div>
            <div className="flex flex-col gap-5">
              <div>
                <SectionTitle>This client</SectionTitle>
                <KeyValueGrid
                  columns={1}
                  items={[
                    { label: 'Client ID', value: data.clientId, mono: true },
                    { label: 'Client IP', value: data.clientIp || '–', mono: true },
                    { label: 'Connected since', value: conn.connectedAt ? formatDateTime(conn.connectedAt) : '–' },
                    { label: 'Subscriptions', value: (conn.subscriptions ?? ['>']).join(', '), mono: true },
                  ]}
                />
              </div>
              {data.jsAccount && (
                <div>
                  <SectionTitle>JetStream account</SectionTitle>
                  <KeyValueGrid
                    columns={1}
                    items={[
                      { label: 'Streams / consumers', value: `${formatNumber(data.jsAccount.streams)} / ${formatNumber(data.jsAccount.consumers)}` },
                      { label: 'Memory', value: `${formatBytes(data.jsAccount.memory)} / ${data.jsAccount.maxMemory < 0 ? '∞' : formatBytes(data.jsAccount.maxMemory)}` },
                      { label: 'Storage', value: `${formatBytes(data.jsAccount.storage)} / ${data.jsAccount.maxStorage < 0 ? '∞' : formatBytes(data.jsAccount.maxStorage)}` },
                      ...(data.jsAccount.domain ? [{ label: 'Domain', value: data.jsAccount.domain, mono: true }] : []),
                    ]}
                  />
                </div>
              )}
            </div>
          </div>

          {(data.connectUrls?.length ?? 0) > 0 && (
            <div>
              <SectionTitle>Cluster members · {data.connectUrls!.length}</SectionTitle>
              <div className="flex flex-wrap gap-1.5">
                {data.connectUrls!.map(u => (
                  <Badge key={u} tone={u === data.addr ? 'accent' : 'neutral'} mono>
                    {u}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ClusterView() {
  const connections = useStore(s => s.connections);

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader title="Servers" />
      <div className="flex-1 min-h-0 overflow-auto p-4 flex flex-col gap-4">
        {connections.length === 0 ? (
          <EmptyState icon={Server} title="No connections" />
        ) : (
          connections.map(c => <ServerCard key={c.id} conn={c} />)
        )}
      </div>
    </div>
  );
}
