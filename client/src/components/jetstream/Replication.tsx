import { ArrowRight, GitFork } from 'lucide-react';
import type { StreamInfo, StreamSource } from 'shared';
import { cn, formatNumber } from '../../lib/utils';
import { useStore } from '../../store';
import { SectionTitle } from '../ui/misc';

/** "lag 12 · 3s ago", or what is known of it. */
export function sourceSummary(src: StreamSource): string {
  const parts: string[] = [];
  if (src.lag !== undefined) parts.push(`lag ${formatNumber(src.lag)}`);
  if (src.active !== undefined) parts.push(src.active < 0 ? 'no activity yet' : `${Math.round(src.active / 1000)}s ago`);
  if (src.filterSubject) parts.push(src.filterSubject);
  return parts.join(' · ');
}

function StreamLink({ name }: { name: string }) {
  const setSelected = useStore(s => s.setSelectedStream);
  return (
    <button type="button" className="font-mono text-accent hover:underline" onClick={() => setSelected(name)} title={`Open ${name}`}>
      {name}
    </button>
  );
}

function Relation({ label, src }: { label: string; src: StreamSource }) {
  const behind = (src.lag ?? 0) > 0;
  return (
    <div className="flex items-center gap-2 text-sm min-w-0">
      <span className="text-muted shrink-0">{label}</span>
      <StreamLink name={src.name} />
      <span className={cn('text-xs truncate', behind ? 'text-warn' : 'text-faint')}>{sourceSummary(src)}</span>
    </div>
  );
}

/**
 * Where a stream's messages come from and who copies them. A mirror that
 * falls behind is the usual reason for "the data is not there yet".
 */
export default function Replication({ stream }: { stream: StreamInfo }) {
  const { mirror, sources, sourcedBy } = stream;
  if (!mirror && !sources?.length && !sourcedBy?.length) return null;
  return (
    <div>
      <SectionTitle>Replication</SectionTitle>
      <div className="card px-3 py-2 flex flex-col gap-1.5">
        {mirror && <Relation label="Mirror of" src={mirror} />}
        {sources?.map(src => (
          <Relation key={src.name} label="Sources from" src={src} />
        ))}
        {sourcedBy?.length ? (
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <span className="text-muted shrink-0 flex items-center gap-1">
              <ArrowRight size={12} /> Used by
            </span>
            {sourcedBy.map(u => (
              <span key={`${u.kind}-${u.name}`} className="flex items-center gap-1">
                <StreamLink name={u.name} />
                <span className="text-xs text-faint">{u.kind}</span>
              </span>
            ))}
          </div>
        ) : null}
        {!mirror && !sources?.length && (
          <span className="text-xs text-faint flex items-center gap-1">
            <GitFork size={11} /> This stream is the origin.
          </span>
        )}
      </div>
    </div>
  );
}
