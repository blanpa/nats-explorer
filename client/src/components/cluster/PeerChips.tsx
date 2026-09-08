import type { ClusterPeer } from 'shared';
import { formatNumber } from '../../lib/utils';
import { Badge } from '../ui/misc';
import { shortServerName } from '../ui/ServerName';

/** Leader first, then the replicas as reported (the leader is not part of its own replica list). */
export default function PeerChips({ peers, leader }: { peers: ClusterPeer[]; leader?: string }) {
  const all = leader && !peers.some(p => p.name === leader) ? [{ name: leader, current: true, offline: false, active: 0, lag: 0 }, ...peers] : peers;
  if (all.length === 0) return <span className="text-faint">–</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {all.map(p => (
        <Badge
          key={p.name}
          mono
          tone={p.offline ? 'danger' : !p.current ? 'warn' : p.name === leader ? 'accent' : 'neutral'}
          title={`${p.name}: ${p.offline ? 'offline' : p.current ? 'current' : 'catching up'}${p.lag ? `, lag ${formatNumber(p.lag)}` : ''}`}
        >
          {shortServerName(p.name)}
          {p.name === leader ? ' ★' : ''}
          {p.lag > 0 ? ` +${formatNumber(p.lag)}` : ''}
        </Badge>
      ))}
    </span>
  );
}
