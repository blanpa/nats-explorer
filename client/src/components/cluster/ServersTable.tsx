import type { ClusterOverview } from 'shared';
import { cn, formatBytes, formatDateTime, formatNumber } from '../../lib/utils';
import { Badge, SectionTitle } from '../ui/misc';
import { ServerName } from '../ui/ServerName';

function uptime(start?: string): string {
  if (!start) return '–';
  const s = Math.max(0, Math.round((Date.now() - new Date(start).getTime()) / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** One row per server of the cluster, with its load and JetStream footprint. */
export default function ServersTable({ servers }: { servers: ClusterOverview['servers'] }) {
  return (
    <div>
      <SectionTitle>Servers · {servers.length}</SectionTitle>
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
            {servers.map(s => (
              <tr key={s.id || s.name}>
                <td className="font-medium">
                  <ServerName name={s.name} />
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
                  {s.jetstream && s.js ? (
                    `${formatNumber(s.js.streams)} streams · ${formatBytes(s.js.storage)} disk · ${formatBytes(s.js.memory)} mem`
                  ) : s.jetstream ? (
                    'enabled'
                  ) : (
                    <span className="text-faint">off</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
