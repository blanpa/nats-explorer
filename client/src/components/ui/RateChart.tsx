import { useEffect, useRef, useState } from 'react';
import { cn, formatCount } from '../../lib/utils';
import { formatTime } from '../../lib/utils';

export interface ChartSeries {
  label: string;
  /** CSS color, e.g. rgb(var(--accent)) */
  color: string;
  values: number[];
}

interface Props {
  title: string;
  times: number[];
  series: ChartSeries[];
  format?: (v: number) => string;
  height?: number;
  className?: string;
  /** shown while fewer than two samples exist */
  placeholder?: string;
}

/** The next round number (1, 2, 2.5, 5 × 10^k) at or above v, so the axis reads 0 / 50 / 100 instead of 0 / 54 / 108. */
function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const m = v / exp;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return step * exp;
}

const defaultFormat = (v: number) => (Number.isInteger(v) ? formatCount(v) : v.toFixed(Math.abs(v) >= 10 ? 1 : 2));

/**
 * Small multi-series line chart for time series (monitoring). Pure SVG, no
 * dependencies; the y axis always starts at zero so rates read honestly.
 */
export function RateChart({ title, times, series, format = defaultFormat, height = 140, className, placeholder = 'Collecting samples…' }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(400);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(160, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = times.length;
  let peak = 0;
  let integers = true;
  for (const s of series)
    for (const v of s.values) {
      if (v > peak) peak = v;
      if (!Number.isInteger(v)) integers = false;
    }
  // Counts get an even whole-number ceiling so the middle tick is a whole number too.
  const max = integers ? Math.max(2, Math.ceil(peak * 1.05) + (Math.ceil(peak * 1.05) % 2)) : niceCeil(peak * 1.05);
  const yTicks = [0, max / 2, max];
  // Left gutter sized to the widest tick label (monospace ≈ 6.2 px per character).
  const labelWidth = Math.max(...yTicks.map(v => format(v).length)) * 6.2 + 10;
  const pad = { top: 8, right: 10, bottom: 18, left: Math.max(36, Math.ceil(labelWidth)) };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const t0 = times[0] ?? 0;
  const t1 = times[n - 1] ?? 1;
  const tRange = Math.max(1, t1 - t0);
  const x = (t: number) => pad.left + ((t - t0) / tRange) * w;
  const y = (v: number) => pad.top + h - (v / max) * h;
  const idx = hover ?? n - 1;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left - pad.left) / w) * tRange;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(times[i] - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };

  const xTickCount = Math.min(5, Math.max(2, Math.floor(w / 90)));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => t0 + (tRange * i) / (xTickCount - 1));

  return (
    <div ref={wrapRef} className={cn('min-w-0', className)}>
      <div className="flex items-baseline gap-3 mb-1 text-xs">
        <span className="font-medium text-muted">{title}</span>
        <span className="ml-auto flex items-center gap-3 font-mono tabular-nums whitespace-nowrap">
          {series.map(s => (
            <span key={s.label} className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: s.color }} />
              <span className="text-faint">{s.label}</span>
              <span className="text-fg">{n > 0 ? format(s.values[idx] ?? 0) : '–'}</span>
            </span>
          ))}
        </span>
      </div>
      {n < 2 ? (
        <div className="flex items-center justify-center text-xs text-faint border border-dashed border-line rounded" style={{ height }}>
          {placeholder}
        </div>
      ) : (
        <svg width={width} height={height} className="block" role="img" aria-label="Rate over time" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {yTicks.map((v, i) => (
            <g key={i}>
              <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} stroke="rgb(var(--border))" strokeDasharray={i === 0 ? undefined : '2 4'} />
              <text x={pad.left - 5} y={y(v) + 3} textAnchor="end" fontSize="10" fill="rgb(var(--fg-faint))" fontFamily="var(--font-mono)">
                {format(v)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text
              key={i}
              x={x(t)}
              y={height - 5}
              textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
              fontSize="10"
              fill="rgb(var(--fg-faint))"
              fontFamily="var(--font-mono)"
            >
              {formatTime(t, false)}
            </text>
          ))}
          {series.map(s => (
            <path
              key={s.label}
              d={times.map((t, i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(s.values[i] ?? 0).toFixed(1)}`).join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          ))}
          {hover !== null && (
            <g>
              <line x1={x(times[hover])} x2={x(times[hover])} y1={pad.top} y2={pad.top + h} stroke="rgb(var(--fg-faint))" strokeDasharray="3 3" />
              {series.map(s => (
                <circle key={s.label} cx={x(times[hover])} cy={y(s.values[hover] ?? 0)} r="3" fill="rgb(var(--bg-1))" stroke={s.color} strokeWidth="1.5" />
              ))}
              <text x={x(times[hover]) + 6} y={pad.top + 10} fontSize="10" fill="rgb(var(--fg-muted))" fontFamily="var(--font-mono)">
                {formatTime(times[hover])}
              </text>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}
