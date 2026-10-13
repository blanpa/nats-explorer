import { useMemo, useState } from 'react';
import { RefreshCw, Settings2, X } from 'lucide-react';
import type { Topology, TopologyGateway } from 'shared';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useStore } from '../../store';
import { cn, formatBytes, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader, SectionTitle, StatStrip, StatTile } from '../ui/misc';
import { type EdgeState, type LaidEdge, layoutTopology, NODE_R, rttMs } from './topologyLayout';

const edgeClass: Record<EdgeState, string> = {
  ok: 'stroke-line-strong',
  warn: 'stroke-warn',
  down: 'stroke-danger',
  'one-sided': 'stroke-faint',
};

const SLOW_RTT_MS = 50;

function Rtt({ value }: { value?: string }) {
  const ms = rttMs(value);
  if (!value) return <span className="text-faint">–</span>;
  return <span className={cn('font-mono', ms !== null && ms > SLOW_RTT_MS && 'text-warn')}>{value}</span>;
}

function Traffic({ t }: { t: { inMsgs: number; outMsgs: number; inBytes: number; outBytes: number } }) {
  return (
    <>
      <td className="num">{formatNumber(t.inMsgs)}</td>
      <td className="num">{formatNumber(t.outMsgs)}</td>
      <td className="num text-muted">
        {formatBytes(t.inBytes)} / {formatBytes(t.outBytes)}
      </td>
    </>
  );
}

function gatewayState(g: TopologyGateway): { tone: 'ok' | 'warn' | 'danger'; text: string } {
  if (!g.connected) return { tone: 'danger', text: g.configured ? 'not connected' : 'gone' };
  if (g.pending > 0) return { tone: 'warn', text: `${formatBytes(g.pending)} pending` };
  return { tone: 'ok', text: 'connected' };
}

/** The picture: clusters as boxes, routes inside them, gateways over them, leaf nodes below. */
function Graph({ t, selected, onSelect }: { t: Topology; selected: string | null; onSelect: (id: string | null) => void }) {
  const lay = useMemo(() => layoutTopology(t), [t]);
  const touches = (e: LaidEdge) => {
    if (!selected) return false;
    if (e.kind === 'gateway') {
      const cluster = t.nodes.find(n => n.id === selected)?.cluster ?? selected;
      return e.a === cluster || e.b === cluster;
    }
    return e.a === selected || e.b === selected;
  };
  return (
    <div className="card overflow-auto shrink-0">
      <svg
        role="img"
        aria-label="Topology of the servers, clusters, gateways and leaf nodes"
        viewBox={`0 0 ${lay.width} ${lay.height}`}
        width={lay.width}
        height={lay.height}
        className="block mx-auto max-w-none"
        onClick={() => onSelect(null)}
      >
        {lay.clusters.map(c => (
          <g key={c.name || `standalone-${c.x}`}>
            <rect
              x={c.x}
              y={c.y}
              width={c.w}
              height={c.h}
              rx={10}
              className={cn('fill-raised/50 stroke-line', selected && c.name && selected === c.name && 'stroke-accent')}
              strokeDasharray={c.unseen ? '5 4' : undefined}
              onClick={e => {
                if (!c.name) return;
                e.stopPropagation();
                onSelect(c.name);
              }}
            />
            {!c.standalone && (
              <text x={c.x + 10} y={c.y + 18} className="fill-muted text-[11px] font-semibold">
                {c.name}
                {c.unseen && <tspan className="fill-faint font-normal"> · not reached</tspan>}
              </text>
            )}
          </g>
        ))}

        {lay.edges.map(e => (
          <g key={e.key}>
            <path
              d={e.d}
              fill="none"
              className={cn(edgeClass[e.state], touches(e) && e.state === 'ok' && 'stroke-accent')}
              strokeWidth={e.kind === 'gateway' ? 2 : 1.5}
              strokeDasharray={e.kind === 'leaf' ? '4 3' : e.state === 'one-sided' || e.state === 'down' ? '6 4' : undefined}
            >
              <title>
                {e.kind === 'gateway'
                  ? `Gateway ${e.a} ↔ ${e.b}${e.state === 'down' ? ' — not connected' : ''}`
                  : e.kind === 'leaf'
                    ? `Leaf node ${e.b} on ${e.a}${e.label ? ` (account ${e.label})` : ''}`
                    : `Route ${e.a} ↔ ${e.b}${e.state === 'one-sided' ? ' — reported by one side only' : ''}`}
              </title>
            </path>
            {e.kind === 'gateway' && e.label && (
              <text x={e.mx} y={e.my - 6} textAnchor="middle" className={cn('text-[10px]', e.state === 'down' ? 'fill-danger' : 'fill-faint')}>
                gateway · {e.label}
              </text>
            )}
          </g>
        ))}

        {lay.nodes.map(n => {
          const active = selected === n.id;
          return (
            <g
              key={n.id}
              className="cursor-pointer"
              onClick={e => {
                e.stopPropagation();
                onSelect(active ? null : n.id);
              }}
            >
              <title>
                {n.kind === 'peer'
                  ? `${n.label} — did not answer; known from the other side of a route or gateway`
                  : n.kind === 'leaf'
                    ? `${n.label} — leaf node`
                    : n.label}
              </title>
              <circle
                cx={n.x}
                cy={n.y}
                r={NODE_R}
                className={cn(
                  n.kind === 'peer' ? 'fill-panel stroke-faint' : n.kind === 'leaf' ? 'fill-panel stroke-ok' : 'fill-panel stroke-accent',
                  active && 'fill-accent/25',
                )}
                strokeWidth={active ? 3 : 2}
                strokeDasharray={n.kind === 'peer' ? '3 3' : undefined}
              />
              <text
                x={n.x}
                y={n.y + NODE_R + 14}
                textAnchor="middle"
                className={cn('text-[11px] font-mono stroke-raised', active ? 'fill-fg' : 'fill-muted')}
                strokeWidth={4}
                paintOrder="stroke"
              >
                {n.label.length > 18 ? `${n.label.slice(0, 8)}…${n.label.slice(-6)}` : n.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 border-t border-line text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <svg width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="5" className="fill-panel stroke-accent" strokeWidth={2} />
          </svg>
          server
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="5" className="fill-panel stroke-faint" strokeWidth={2} strokeDasharray="2 2" />
          </svg>
          did not answer
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="5" className="fill-panel stroke-ok" strokeWidth={2} />
          </svg>
          leaf node
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="22" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="22" y2="4" className="stroke-danger" strokeWidth={2} strokeDasharray="6 4" />
          </svg>
          not connected
        </span>
        <span className="ml-auto text-faint">Click a server to narrow the tables to it.</span>
      </div>
    </div>
  );
}

/** Who is connected to whom: routes, gateways and leaf nodes, drawn and listed. */
export default function TopologyView({ connId }: { connId: string }) {
  const conn = useStore(s => s.connections.find(c => c.id === connId));
  const openConnections = useStore(s => s.openConnectionsDialog);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, loading, initial, reload } = useAsync<Topology>(
    () => (conn?.connected ? api.clusterTopology(connId) : null),
    [connId, conn?.connected],
    { key: `topology:${connId}`, interval: 10_000 },
  );

  const header = (
    <PaneHeader title="Topology">
      {data && (
        <Badge
          tone={data.source === 'system' ? 'ok' : 'warn'}
          title={data.source === 'system' ? 'Every server answered on the system account' : 'Only the connected server is asked'}
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
        <ErrorState title="Cannot load the topology" message={error ?? undefined} />
      </>
    );

  const selCluster = selected ? (data.nodes.find(n => n.id === selected)?.cluster ?? selected) : null;
  const isCluster = !!selected && !data.nodes.some(n => n.id === selected);
  const routes = data.routes.filter(
    r => !selected || (isCluster ? data.nodes.find(n => n.id === r.server)?.cluster === selected : r.server === selected || r.remote === selected),
  );
  const gateways = data.gateways.filter(
    g => !selected || (isCluster ? g.cluster === selCluster || g.remote === selCluster : g.server === selected || g.remoteServer === selected),
  );
  const leafs = data.leafs.filter(
    l => !selected || (isCluster ? data.nodes.find(n => n.id === l.server)?.cluster === selected : l.server === selected || l.name === selected),
  );

  const servers = data.nodes.filter(n => n.kind === 'server');
  const silent = data.nodes.filter(n => n.kind === 'peer');
  const clusters = new Set(data.nodes.filter(n => n.kind !== 'leaf' && n.cluster).map(n => n.cluster));
  for (const g of data.gateways) clusters.add(g.remote);
  const down = data.gateways.filter(g => !g.connected);
  const slow = [...data.routes, ...data.gateways, ...data.leafs].filter(x => (rttMs(x.rtt) ?? 0) > SLOW_RTT_MS);
  const pending = [...data.routes, ...data.gateways].filter(x => x.pending > 0);
  const nothing = data.routes.length === 0 && data.gateways.length === 0 && data.leafs.length === 0;

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
          <StatTile label="Clusters" value={formatNumber(clusters.size)} />
          <StatTile
            label="Servers"
            value={formatNumber(servers.length)}
            sub={silent.length ? `${silent.length} more did not answer` : undefined}
            tone={silent.length ? 'warn' : undefined}
          />
          <StatTile label="Routes" value={formatNumber(new Set(data.routes.map(r => [r.server, r.remote].sort().join('\u0000'))).size)} />
          <StatTile
            label="Gateway connections"
            value={formatNumber(data.gateways.length)}
            sub={down.length ? `${down.length} not connected` : undefined}
            tone={down.length ? 'danger' : undefined}
          />
          <StatTile label="Leaf nodes" value={formatNumber(data.leafs.length)} />
          <StatTile
            label="Attention"
            value={formatNumber(down.length + slow.length + pending.length)}
            sub={
              [slow.length && `${slow.length} RTT over ${SLOW_RTT_MS} ms`, pending.length && `${pending.length} with pending bytes`]
                .filter(Boolean)
                .join(' · ') || undefined
            }
            tone={down.length ? 'danger' : slow.length + pending.length ? 'warn' : 'ok'}
          />
        </StatStrip>

        {nothing ? (
          <EmptyState
            compact
            title="A single server"
            description="No routes, gateways or leaf nodes: this server runs alone. A cluster, a super-cluster or a leaf node shows up here once it is configured."
          />
        ) : (
          <Graph t={data} selected={selected} onSelect={setSelected} />
        )}

        {selected && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">Showing the connections of</span>
            <Badge tone="accent" mono>
              {selected}
            </Badge>
            <Button size="xs" variant="ghost" icon={<X size={12} />} onClick={() => setSelected(null)}>
              Show all
            </Button>
          </div>
        )}

        {gateways.length > 0 && (
          <div>
            <SectionTitle>Gateways · {gateways.length}</SectionTitle>
            <div className="card overflow-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Server</th>
                    <th>Gateway</th>
                    <th>Direction</th>
                    <th>State</th>
                    <th>Remote server</th>
                    <th>Address</th>
                    <th>RTT</th>
                    <th>Up</th>
                    <th>Idle</th>
                    <th className="num">Subs</th>
                    <th className="num">Msgs in</th>
                    <th className="num">Msgs out</th>
                    <th className="num">Bytes in / out</th>
                  </tr>
                </thead>
                <tbody>
                  {gateways.map((g, i) => {
                    const st = gatewayState(g);
                    return (
                      <tr key={`${g.server}-${g.remote}-${g.direction}-${g.remoteServer ?? i}-${i}`}>
                        <td className="font-mono">{g.server}</td>
                        <td className="font-mono">
                          {g.cluster} → {g.remote}
                        </td>
                        <td className="text-muted">
                          {g.direction}
                          {g.configured && <span className="text-faint"> · configured</span>}
                        </td>
                        <td>
                          <Badge tone={st.tone}>{st.text}</Badge>
                        </td>
                        <td className="font-mono text-muted">{g.remoteServer ?? '–'}</td>
                        <td className="font-mono text-muted">{g.address ?? '–'}</td>
                        <td>
                          <Rtt value={g.rtt} />
                        </td>
                        <td className="font-mono text-muted">{g.uptime ?? '–'}</td>
                        <td className="font-mono text-muted">{g.idle ?? '–'}</td>
                        <td className="num">{formatNumber(g.subscriptions)}</td>
                        <Traffic t={g} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {routes.length > 0 && (
          <div>
            <SectionTitle>Routes · {routes.length}</SectionTitle>
            <div className="card overflow-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Server</th>
                    <th>Remote</th>
                    <th className="num">Connections</th>
                    <th>RTT</th>
                    <th className="num">Pending</th>
                    <th className="num">Subs</th>
                    <th>Compression</th>
                    <th className="num">Msgs in</th>
                    <th className="num">Msgs out</th>
                    <th className="num">Bytes in / out</th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map(r => (
                    <tr key={`${r.server}-${r.remote}`}>
                      <td className="font-mono">{r.server}</td>
                      <td className="font-mono">
                        {r.remote}
                        {r.configured && <span className="text-faint font-sans"> · configured</span>}
                      </td>
                      <td className="num">{r.connections}</td>
                      <td>
                        <Rtt value={r.rtt} />
                      </td>
                      <td className={cn('num', r.pending > 0 && 'text-warn')}>{formatBytes(r.pending)}</td>
                      <td className="num">{formatNumber(r.subscriptions)}</td>
                      <td className="text-muted">{r.compression || '–'}</td>
                      <Traffic t={r} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {leafs.length > 0 && (
          <div>
            <SectionTitle>Leaf nodes · {leafs.length}</SectionTitle>
            <div className="card overflow-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Hub server</th>
                    <th>Leaf node</th>
                    <th>Account</th>
                    <th>Address</th>
                    <th>RTT</th>
                    <th className="num">Subs</th>
                    <th>Compression</th>
                    <th className="num">Msgs in</th>
                    <th className="num">Msgs out</th>
                    <th className="num">Bytes in / out</th>
                  </tr>
                </thead>
                <tbody>
                  {leafs.map((l, i) => (
                    <tr key={`${l.server}-${l.name}-${l.account}-${i}`}>
                      <td className="font-mono">{l.server}</td>
                      <td className="font-mono">
                        {l.name}
                        {l.spoke && <span className="text-faint font-sans"> · spoke</span>}
                      </td>
                      <td className="font-mono text-muted">{l.account}</td>
                      <td className="font-mono text-muted">{l.address}</td>
                      <td>
                        <Rtt value={l.rtt} />
                      </td>
                      <td className="num">{formatNumber(l.subscriptions)}</td>
                      <td className="text-muted">{l.compression || '–'}</td>
                      <Traffic t={l} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
