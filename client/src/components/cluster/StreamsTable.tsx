import type { ClusterOverview } from 'shared';
import { formatBytes, formatNumber } from '../../lib/utils';
import { SectionTitle } from '../ui/misc';
import { ServerName } from '../ui/ServerName';
import PeerChips from './PeerChips';

/** Every stream of the cluster with its leader and, on a multi-server cluster, where its replicas sit. */
export default function StreamsTable({ streams, multiServer }: { streams: ClusterOverview['streams']; multiServer: boolean }) {
  return (
    <div>
      <SectionTitle>Streams · {streams.length}</SectionTitle>
      {streams.length === 0 ? (
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
                {multiServer && <th>Placement</th>}
                <th className="num">Messages</th>
                <th className="num">Size</th>
                <th className="num">Consumers</th>
              </tr>
            </thead>
            <tbody>
              {streams.map(s => (
                <tr key={`${s.account}/${s.name}`}>
                  <td className="font-mono">{s.name}</td>
                  <td className="text-muted">{s.account}</td>
                  <td className="text-muted">{s.storage || '–'}</td>
                  <td className="num">{s.replicas || 1}</td>
                  <td className="font-mono">{s.leader ? <ServerName name={s.leader} /> : <span className="text-faint">–</span>}</td>
                  {multiServer && (
                    <td>
                      <PeerChips peers={s.peers ?? []} leader={s.leader} />
                    </td>
                  )}
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
  );
}
