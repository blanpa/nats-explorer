import type { Connz } from 'shared';
import { formatBytes, formatNumber } from '../../lib/utils';
import { SectionTitle } from '../ui/misc';

/** The server's client connections as connz reports them. */
export default function ConnectionsTable({ connz }: { connz: Connz }) {
  return (
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
              <th className="num">RTT</th>
              <th className="num">Uptime</th>
              <th className="num">Idle</th>
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
                <td className="num text-muted">{c.rtt || '–'}</td>
                <td className="num text-muted">{c.uptime}</td>
                <td className="num text-muted">{c.idle}</td>
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
  );
}
