import { cn, formatBytes } from '../../lib/utils';

/** Used versus configured maximum, colored as it fills up. */
export default function UsageBar({ used, max, label }: { used: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span className="text-muted">{label}</span>
        <span className="font-mono tabular-nums">
          {formatBytes(used)} <span className="text-faint">/ {max > 0 ? formatBytes(max) : '∞'}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-field overflow-hidden">
        <div className={cn('h-full rounded-full', pct > 90 ? 'bg-danger' : pct > 70 ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
