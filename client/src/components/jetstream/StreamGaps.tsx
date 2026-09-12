import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { formatNumber } from '../../lib/utils';
import { SectionTitle } from '../ui/misc';

/**
 * The sequences a stream does not have.
 *
 * A stream counts sequences without promising to keep every one: a delete, a
 * purge with a sequence bound or a per-subject limit leaves a hole. From the
 * outside "my consumer skipped a message" and "the stream never had it" look
 * the same, and this is the difference -- which is why it is only shown when
 * there is a hole to point at.
 */
export default function StreamGaps({ connId, stream, numDeleted }: { connId: string; stream: string; numDeleted: number }) {
  const { data } = useAsync(() => (numDeleted > 0 ? api.getStreamGaps(connId, stream) : null), [connId, stream, numDeleted], {
    key: `gaps:${connId}:${stream}:${numDeleted}`,
  });
  if (!data || data.missing === 0) return null;

  return (
    <div>
      <SectionTitle>Sequence gaps</SectionTitle>
      <div className="card px-3 py-2 flex flex-col gap-1.5">
        <div className="text-sm">
          <span className="font-mono tabular-nums text-warn">{formatNumber(data.missing)}</span> {data.missing === 1 ? 'sequence between' : 'sequences between'}{' '}
          {formatNumber(data.firstSeq)} and {formatNumber(data.lastSeq)} {data.missing === 1 ? 'is' : 'are'} not stored.
        </div>
        {data.listed ? (
          <div className="flex flex-wrap gap-1.5 font-mono text-xs">
            {data.ranges.map(g => (
              <span key={`${g.from}-${g.to}`} className="rounded border border-line px-1.5 py-0.5 tabular-nums">
                {g.from === g.to ? formatNumber(g.from) : `${formatNumber(g.from)} – ${formatNumber(g.to)}`}
              </span>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted">Too many to list one by one.</div>
        )}
        <div className="text-xs text-faint">
          Deleted, purged up to a sequence, or removed by a per-subject limit. A consumer walking the stream skips these numbers; it has not missed anything.
        </div>
      </div>
    </div>
  );
}
