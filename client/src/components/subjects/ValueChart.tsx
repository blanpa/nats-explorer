import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistorySeries, NatsMessage } from 'shared';
import { extractNumber, formatCount, formatTime, readSetting, writeSetting } from '../../lib/utils';
import { Segmented } from '../ui/misc';

export interface Point {
  t: number;
  v: number;
}

interface Props {
  /** live messages of the subject; those newer than the series are appended */
  messages: NatsMessage[];
  /** the field over the recorded history, downsampled by the server */
  series?: HistorySeries | null;
  fieldPath: string;
  height?: number;
  /** clicking a point asks for the message behind it */
  onPick?: (point: Point) => void;
  /** the message the payload viewer shows, marked in the chart */
  marker?: Point | null;
}

/**
 * Keeps at most about 2×buckets points: every bucket contributes its
 * minimum and maximum in time order, so peaks survive.
 */
export function decimate(points: Point[], buckets: number): Point[] {
  if (buckets <= 0 || points.length <= buckets) return points;
  const out: Point[] = [];
  const size = points.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.min(points.length, Math.floor((b + 1) * size));
    if (start >= end) continue;
    let lo = start;
    let hi = start;
    for (let i = start + 1; i < end; i++) {
      if (points[i].v < points[lo].v) lo = i;
      if (points[i].v > points[hi].v) hi = i;
    }
    if (lo === hi) out.push(points[lo]);
    else if (lo < hi) out.push(points[lo], points[hi]);
    else out.push(points[hi], points[lo]);
  }
  return out;
}

/** Series points plus live messages the series does not cover yet. */
export function mergePoints(series: HistorySeries | null | undefined, messages: NatsMessage[], fieldPath: string): Point[] {
  const out: Point[] = series ? series.points.map(([t, v]) => ({ t, v })) : [];
  const after = series?.last ?? 0;
  for (const m of messages) {
    if (m.payloadType !== 'json') continue;
    if (series && (m.sequence ?? 0) <= after) continue;
    const v = extractNumber(m.payload, fieldPath);
    if (v !== null) out.push({ t: m.timestamp, v });
  }
  return out;
}

export type ChartType = 'line' | 'area' | 'step' | 'bars' | 'dots';
const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'step', label: 'Step' },
  { id: 'bars', label: 'Bars' },
  { id: 'dots', label: 'Dots' },
];
const CHART_TYPE_KEY = 'ne.chartType';

function niceNumber(v: number): string {
  const abs = Math.abs(v);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: Number.isInteger(v) ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4 }).format(v);
}

export default function ValueChart({ messages, series, fieldPath, height = 160, onPick, marker }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [type, setTypeState] = useState<ChartType>(() => {
    const saved = readSetting<string>(CHART_TYPE_KEY, 'line');
    return CHART_TYPES.some(t => t.id === saved) ? (saved as ChartType) : 'line';
  });
  const setType = (t: ChartType) => {
    writeSetting(CHART_TYPE_KEY, t);
    setTypeState(t);
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.max(200, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const all = useMemo(() => mergePoints(series, messages, fieldPath), [series, messages, fieldPath]);
  // No more points than the chart has pixels for.
  const points = useMemo(() => decimate(all, Math.max(50, Math.floor(width / 2))), [all, width]);

  if (points.length < 2) {
    return (
      <div ref={wrapRef} className="text-xs text-muted py-6 text-center">
        Collecting data points for <span className="font-mono text-syn-num">{fieldPath}</span> · {points.length}/2
      </div>
    );
  }

  const pad = { top: 14, right: 14, bottom: 22, left: 56 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  // Bars are read against zero, so the axis must include it.
  if (type === 'bars') {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const tRange = Math.max(1, t1 - t0);
  const x = (t: number) => pad.left + ((t - t0) / tRange) * w;
  const y = (v: number) => pad.top + h - ((v - min) / (max - min)) * h;

  const line =
    type === 'step'
      ? points.map((p, i) => (i ? `H${x(p.t).toFixed(1)} V${y(p.v).toFixed(1)}` : `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)).join(' ')
      : points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(t1).toFixed(1)},${pad.top + h} L${x(t0).toFixed(1)},${pad.top + h} Z`;
  const barWidth = Math.max(1, Math.min(14, (w / points.length) * 0.7));
  const zeroY = y(0);

  const yTicks = Array.from({ length: 4 }, (_, i) => min + ((max - min) * i) / 3);
  const xTickCount = Math.min(6, Math.max(2, Math.floor(w / 110)));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => t0 + (tRange * i) / (xTickCount - 1));

  const latest = points[points.length - 1];
  const prev = points[points.length - 2];
  const delta = latest.v - prev.v;
  const hovered = hover !== null ? points[hover] : null;
  // Where the message in the payload viewer sits, when it is in this window.
  const marked = marker && marker.t >= t0 && marker.t <= t1 ? marker : null;
  const shown = hovered ?? marked ?? latest;

  // The point nearest to the cursor, by time.
  const nearest = (clientX: number, rect: DOMRect): number => {
    const t = t0 + ((clientX - rect.left - pad.left) / w) * tRange;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].t - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()));

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onPick) return;
    onPick(points[nearest(e.clientX, e.currentTarget.getBoundingClientRect())]);
  };

  return (
    <div ref={wrapRef} className="w-full">
      <div className="flex items-baseline gap-3 mb-1 text-xs min-w-0">
        <span className="font-mono text-syn-num">{fieldPath}</span>
        <span className="font-mono text-md font-semibold text-fg tabular-nums">{niceNumber(shown.v)}</span>
        {!hovered && !marked && delta !== 0 && (
          <span className={delta > 0 ? 'text-ok' : 'text-danger'}>
            {delta > 0 ? '▲' : '▼'} {niceNumber(Math.abs(delta))}
          </span>
        )}
        {hovered && <span className="text-muted font-mono">{formatTime(hovered.t)}</span>}
        {!hovered && marked && <span className="text-accent font-mono">{formatTime(marked.t)}</span>}
        {onPick && !hovered && <span className="text-faint hidden 2xl:inline whitespace-nowrap">click a point for its message</span>}
        <span className="ml-auto min-w-0 truncate text-faint font-mono tabular-nums">
          min {niceNumber(min)} · max {niceNumber(max)} · {formatCount(all.length)} pts
          {series && series.samples > 0 && <span className="text-faint"> · {formatCount(series.samples)} in history</span>}
          {/* Over long ranges the points are minute aggregates, not messages. */}
          {series?.source === 'rollup' && <span className="text-faint"> · per minute</span>}
        </span>
        <span className="shrink-0">
          <Segmented size="xs" options={CHART_TYPES} value={type} onChange={setType} />
        </span>
      </div>
      <svg
        width={width}
        height={height}
        className={onPick ? 'block cursor-pointer' : 'block'}
        role="img"
        aria-label={`${fieldPath} over time`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={onClick}
      >
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} stroke="rgb(var(--border))" strokeDasharray="2 4" />
            <text x={pad.left - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="rgb(var(--fg-faint))" fontFamily="var(--font-mono)">
              {niceNumber(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text
            key={i}
            x={x(t)}
            y={height - 6}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            fontSize="10"
            fill="rgb(var(--fg-faint))"
            fontFamily="var(--font-mono)"
          >
            {formatTime(t, false)}
          </text>
        ))}
        {type === 'bars' &&
          points.map((p, i) => {
            const top = Math.min(y(p.v), zeroY);
            const hgt = Math.max(1, Math.abs(y(p.v) - zeroY));
            return (
              <rect
                key={i}
                x={x(p.t) - barWidth / 2}
                y={top}
                width={barWidth}
                height={hgt}
                fill={hover === i ? 'rgb(var(--accent))' : 'rgb(var(--accent) / 0.55)'}
              />
            );
          })}
        {type === 'bars' && <line x1={pad.left} x2={width - pad.right} y1={zeroY} y2={zeroY} stroke="rgb(var(--fg-faint))" />}
        {type === 'dots' && points.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.v)} r={2.5} fill="rgb(var(--accent))" />)}
        {type === 'area' && <path d={area} fill="rgb(var(--accent) / 0.12)" />}
        {(type === 'line' || type === 'area' || type === 'step') && (
          <path d={line} fill="none" stroke="rgb(var(--accent))" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
        )}
        {type !== 'bars' && <circle cx={x(latest.t)} cy={y(latest.v)} r="3" fill="rgb(var(--accent))" stroke="rgb(var(--bg-1))" strokeWidth="1.5" />}
        {/* The message on screen: a filled dot, so it reads apart from the hover ring. */}
        {marked && (
          <g pointerEvents="none">
            <line x1={x(marked.t)} x2={x(marked.t)} y1={pad.top} y2={pad.top + h} stroke="rgb(var(--accent) / 0.5)" />
            <circle cx={x(marked.t)} cy={y(marked.v)} r="5" fill="rgb(var(--accent))" stroke="rgb(var(--bg-1))" strokeWidth="2" />
          </g>
        )}
        {hovered && (
          <g>
            <line x1={x(hovered.t)} x2={x(hovered.t)} y1={pad.top} y2={pad.top + h} stroke="rgb(var(--fg-faint))" strokeDasharray="3 3" />
            <circle cx={x(hovered.t)} cy={y(hovered.v)} r="3.5" fill="rgb(var(--bg-1))" stroke="rgb(var(--accent))" strokeWidth="2" />
          </g>
        )}
      </svg>
    </div>
  );
}
