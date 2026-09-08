import type { Routez } from 'shared';
import { formatBytes, formatNumber } from '../../lib/utils';
import { SectionTitle } from '../ui/misc';

export interface PeerRow {
  key: string;
  name: string;
  addr: string;
  rtt?: string;
  inMsgs?: number;
  outMsgs?: number;
  inBytes?: number;
  outBytes?: number;
  subs?: number;
  extra?: string;
}

/** nats-server 2.10+ opens a pool of route connections per peer; show one row per peer with the pool summed up. */
export function groupRoutes(routes: Routez['routes']): PeerRow[] {
  const byPeer = new Map<
    string,
    {
      name: string;
      addr: string;
      rtt?: string;
      subs: number;
      inMsgs: number;
      outMsgs: number;
      inBytes: number;
      outBytes: number;
      pending: number;
      count: number;
    }
  >();
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
    extra:
      [g.count > 1 ? `${g.count} connections` : undefined, g.pending ? `${formatBytes(g.pending)} pending` : undefined].filter(Boolean).join(' · ') ||
      undefined,
  }));
}

/** Routes or leaf nodes: one row per peer. */
export default function PeerTable({ title, rows }: { title: string; rows: PeerRow[] }) {
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
