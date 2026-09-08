import { formatDurationMs, formatNumber } from '../../lib/utils';

export interface LatencyBucket {
  /** upper bound in milliseconds; 0 means everything above the last bound */
  le: number;
  count: number;
}

/** The bar label: "≤ 5 ms", or "slower" for the overflow bucket. */
export function bucketLabel(b: LatencyBucket): string {
  return b.le > 0 ? `≤ ${formatDurationMs(b.le)}` : 'slower';
}

/**
 * Where the replies landed, as bars. A summary hides a bimodal distribution
 * (most replies fast, a few on a timeout); the shape does not.
 */
export default function LatencyHistogram({ buckets }: { buckets: LatencyBucket[] }) {
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  if (max === 0) return null;
  const total = buckets.reduce((n, b) => n + b.count, 0);
  return (
    <div className="flex items-end gap-1 h-16" role="img" aria-label="Reply latency distribution">
      {buckets.map(b => (
        <div
          key={b.le}
          className="flex-1 min-w-0 flex flex-col justify-end items-center gap-1 group"
          title={`${formatNumber(b.count)} of ${formatNumber(total)} ${bucketLabel(b)}`}
        >
          <span className="text-[10px] text-faint tabular-nums opacity-0 group-hover:opacity-100">{b.count || ''}</span>
          <div
            className={b.le > 0 ? 'w-full rounded-sm bg-accent/70 group-hover:bg-accent' : 'w-full rounded-sm bg-warn/70 group-hover:bg-warn'}
            style={{ height: `${Math.max(b.count > 0 ? 2 : 0, (b.count / max) * 46)}px` }}
          />
          <span className="text-[9px] text-faint font-mono truncate w-full text-center">{b.le > 0 ? formatDurationMs(b.le) : '∞'}</span>
        </div>
      ))}
    </div>
  );
}
