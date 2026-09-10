import { useEffect, useMemo, useRef, useState } from 'react';
import type { Aggregation, HistorySeries, NatsMessage } from 'shared';
import { cn, extractNumber, formatCount, formatDurationMs, formatTime } from '../../lib/utils';

export interface Point {
  t: number;
  v: number;
}

/** One field drawn in a chart, with the colour it is known by. */
export interface ChartSeries {
  field: string;
  points: Point[];
  color: string;
  /** what the server reported for this field, for the footer */
  info?: HistorySeries | null;
}

interface Props {
  /** the fields to draw; several of them share one pair of axes */
  series: ChartSeries[];
  height?: number;
  /** clicking a point asks for the message behind it */
  onPick?: (point: Point, field: string) => void;
  /** the message the payload viewer shows, marked in the chart */
  marker?: Point | null;
  type: ChartType;
  /**
   * Scales every series to its own 0..1 so fields with different units share
   * an axis. The values in the header stay the real ones -- a chart whose
   * axis is meaningless must not also show meaningless numbers.
   */
  normalize?: boolean;
  /**
   * Dragging across the chart hands back the stretch of time that was
   * covered. Left out, the chart is not a way of choosing a window and does
   * not pretend to be one: no crosshair, no band.
   */
  onZoom?: (from: number, to: number) => void;
}

/**
 * How far the pointer has to travel before it counts as a drag rather than
 * a click. Below this a chart is being pointed at, not brushed.
 */
const DRAG_PX = 6;

/** The narrowest window a drag can produce, so a twitch cannot empty the chart. */
const MIN_SPAN_MS = 500;

/**
 * The colours a chart hands out, in order. They are theme variables, so a
 * series keeps its colour when the theme flips.
 */
export const SERIES_COLORS = ['rgb(var(--accent))', 'rgb(var(--warn))', 'rgb(var(--ok))', 'rgb(var(--syn-bool))', 'rgb(var(--danger))', 'rgb(var(--syn-str))'];

export const colorForIndex = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

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

/**
 * Series points plus live messages the series does not cover yet.
 *
 * Only the raw min/max reduction can be extended this way. Appending one
 * message to an average, a sum or a count would put an unreduced value next
 * to reduced ones and the last bucket would jump; those wait for the next
 * answer from the server instead.
 */
export function mergePoints(series: HistorySeries | null | undefined, messages: NatsMessage[], fieldPath: string, agg: Aggregation = 'minmax'): Point[] {
  const out: Point[] = series ? series.points.map(([t, v]) => ({ t, v })) : [];
  if (series && agg !== 'minmax') return out;
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
export const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'step', label: 'Step' },
  { id: 'bars', label: 'Bars' },
  { id: 'dots', label: 'Dots' },
];

export function niceNumber(v: number): string {
  const abs = Math.abs(v);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: Number.isInteger(v) ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4 }).format(v);
}

interface Scaled {
  s: ChartSeries;
  points: Point[];
  min: number;
  max: number;
}

export default function ValueChart({ series, height = 160, onPick, marker, type, normalize = false, onZoom }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hoverT, setHoverT] = useState<number | null>(null);
  // The stretch being dragged, in time. Held here rather than in pixels so
  // it survives a resize mid-drag and reads the same as everything else.
  const [band, setBand] = useState<{ a: number; b: number } | null>(null);
  const dragFrom = useRef<number | null>(null);
  // A drag ends in a click as well; that click belongs to the drag.
  const swallowClick = useRef(false);

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

  // No more points per series than the chart has pixels for.
  const scaled: Scaled[] = useMemo(() => {
    const buckets = Math.max(50, Math.floor(width / 2));
    return series
      .map(s => {
        const points = decimate(s.points, buckets);
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (const p of points) {
          if (p.v < min) min = p.v;
          if (p.v > max) max = p.v;
        }
        return { s, points, min, max };
      })
      .filter(x => x.points.length > 0);
  }, [series, width]);

  const drawable = scaled.filter(x => x.points.length >= 2);
  if (drawable.length === 0) {
    const names = series.map(s => s.field).join(', ') || 'a field';
    const have = scaled.reduce((n, x) => n + x.points.length, 0);
    return (
      <div ref={wrapRef} className="text-xs text-muted py-6 text-center">
        Collecting data points for <span className="font-mono text-syn-num">{names}</span> · {have}/2
      </div>
    );
  }

  const pad = { top: 14, right: 14, bottom: 22, left: 56 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;

  // A shared axis needs one range over every series; a normalized one gives
  // each series its own and labels the axis in per cent.
  let axisMin = Number.POSITIVE_INFINITY;
  let axisMax = Number.NEGATIVE_INFINITY;
  for (const d of drawable) {
    if (d.min < axisMin) axisMin = d.min;
    if (d.max > axisMax) axisMax = d.max;
  }
  if (type === 'bars') {
    axisMin = Math.min(axisMin, 0);
    axisMax = Math.max(axisMax, 0);
  }
  if (axisMin === axisMax) {
    axisMin -= 1;
    axisMax += 1;
  }

  let t0 = Number.POSITIVE_INFINITY;
  let t1 = Number.NEGATIVE_INFINITY;
  for (const d of drawable) {
    if (d.points[0].t < t0) t0 = d.points[0].t;
    if (d.points[d.points.length - 1].t > t1) t1 = d.points[d.points.length - 1].t;
  }
  const tRange = Math.max(1, t1 - t0);
  const x = (t: number) => pad.left + ((t - t0) / tRange) * w;

  /** Where a value of one series sits: on the shared axis, or on its own. */
  const yOf = (d: Scaled) => {
    if (!normalize) return (v: number) => pad.top + h - ((v - axisMin) / (axisMax - axisMin)) * h;
    const lo = d.min === d.max ? d.min - 1 : d.min;
    const hi = d.min === d.max ? d.max + 1 : d.max;
    return (v: number) => pad.top + h - ((v - lo) / (hi - lo)) * h;
  };

  const pathOf = (points: Point[], y: (v: number) => number) =>
    type === 'step'
      ? points.map((p, i) => (i ? `H${x(p.t).toFixed(1)} V${y(p.v).toFixed(1)}` : `M${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)).join(' ')
      : points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');

  const yTicks = Array.from({ length: 4 }, (_, i) => (normalize ? i / 3 : axisMin + ((axisMax - axisMin) * i) / 3));
  const yAt = (v: number) => (normalize ? pad.top + h - v * h : yOf(drawable[0])(v));
  const xTickCount = Math.min(6, Math.max(2, Math.floor(w / 110)));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => t0 + (tRange * i) / (xTickCount - 1));

  /** The point of a series nearest to a time. */
  const nearestIn = (points: Point[], t: number): Point => {
    let best = points[0];
    let bestD = Infinity;
    for (const p of points) {
      const d = Math.abs(p.t - t);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  };

  const timeAt = (clientX: number, rect: DOMRect) => t0 + ((clientX - rect.left - pad.left) / w) * tRange;
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => setHoverT(timeAt(e.clientX, e.currentTarget.getBoundingClientRect()));

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!onZoom || e.button !== 0) return;
    dragFrom.current = e.clientX;
    const t = timeAt(e.clientX, e.currentTarget.getBoundingClientRect());
    setBand({ a: t, b: t });
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragFrom.current === null) return;
    const t = timeAt(e.clientX, e.currentTarget.getBoundingClientRect());
    setBand(b => (b ? { a: b.a, b: t } : b));
  };
  const cancelDrag = () => {
    dragFrom.current = null;
    setBand(null);
  };
  const onUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const start = dragFrom.current;
    const b = band;
    cancelDrag();
    if (start === null || !b || !onZoom) return;
    if (Math.abs(e.clientX - start) < DRAG_PX) return;
    // Only over the data: a drag that runs off the plot means "to the end",
    // not "into a stretch of time the chart never showed".
    const from = Math.max(t0, Math.min(b.a, b.b));
    const to = Math.min(t1, Math.max(b.a, b.b));
    swallowClick.current = true;
    onZoom(Math.round(from), Math.round(Math.max(to, from + MIN_SPAN_MS)));
  };

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    if (!onPick) return;
    const t = timeAt(e.clientX, e.currentTarget.getBoundingClientRect());
    // With several series the click belongs to the one whose point is
    // closest in time, which is the one being pointed at.
    let best = drawable[0];
    let bestD = Infinity;
    for (const d of drawable) {
      const dist = Math.abs(nearestIn(d.points, t).t - t);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    onPick(nearestIn(best.points, t), best.s.field);
  };

  const hoveredT = hoverT !== null ? nearestIn(drawable[0].points, hoverT).t : null;
  const bandSpan = band ? Math.abs(band.b - band.a) : 0;
  const bandX = band ? [Math.min(x(band.a), x(band.b)), Math.max(x(band.a), x(band.b))] : null;
  const marked = marker && marker.t >= t0 && marker.t <= t1 ? marker : null;
  const single = drawable.length === 1 ? drawable[0] : null;
  const totalPoints = series.reduce((n, s) => n + s.points.length, 0);
  const info = single?.s.info;
  const barWidth = single ? Math.max(1, Math.min(14, (w / single.points.length) * 0.7)) : 0;
  const zeroY = single ? (normalize ? pad.top + h : yOf(single)(0)) : 0;

  return (
    <div ref={wrapRef} className="w-full">
      <div className="flex items-baseline gap-3 mb-1 text-xs min-w-0 flex-wrap">
        {drawable.map(d => {
          const at = hoverT !== null ? nearestIn(d.points, hoverT) : marked ? nearestIn(d.points, marked.t) : d.points[d.points.length - 1];
          return (
            <span key={d.s.field} className="flex items-baseline gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-full shrink-0 self-center" style={{ background: d.s.color }} aria-hidden />
              <span className="font-mono text-muted truncate">{d.s.field}</span>
              <span className="font-mono font-semibold text-fg tabular-nums">{niceNumber(at.v)}</span>
            </span>
          );
        })}
        {band && bandSpan > 0 ? (
          <span className="text-accent font-mono">
            {formatTime(Math.min(band.a, band.b), false)} + {formatDurationMs(bandSpan)}
          </span>
        ) : (
          <>
            {hoveredT !== null && <span className="text-muted font-mono">{formatTime(hoveredT)}</span>}
            {hoverT === null && marked && <span className="text-accent font-mono">{formatTime(marked.t)}</span>}
          </>
        )}
        <span className="ml-auto min-w-0 truncate text-faint font-mono tabular-nums">
          {single ? `min ${niceNumber(single.min)} · max ${niceNumber(single.max)} · ` : ''}
          {formatCount(totalPoints)} pts
          {info && info.samples > 0 && <span> · {formatCount(info.samples)} in history</span>}
          {/* Over long ranges the points are minute aggregates, not messages. */}
          {info?.source === 'rollup' && <span> · per minute</span>}
          {normalize && <span> · scaled per field</span>}
        </span>
      </div>
      <svg
        width={width}
        height={height}
        className={cn('block', onZoom && 'cursor-crosshair select-none', !onZoom && onPick && 'cursor-pointer')}
        role="img"
        aria-label={`${series.map(s => s.field).join(', ')} over time`}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverT(null)}
        onPointerDown={onDown}
        onPointerMove={onDrag}
        onPointerUp={onUp}
        onPointerCancel={cancelDrag}
        onClick={onClick}
      >
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={pad.left} x2={width - pad.right} y1={yAt(v)} y2={yAt(v)} stroke="rgb(var(--border))" strokeDasharray="2 4" />
            <text x={pad.left - 6} y={yAt(v) + 3} textAnchor="end" className="text-2xs font-mono" fill="rgb(var(--fg-faint))">
              {normalize ? `${Math.round(v * 100)}%` : niceNumber(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text
            key={i}
            x={x(t)}
            y={height - 6}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            className="text-2xs font-mono"
            fill="rgb(var(--fg-faint))"
          >
            {formatTime(t, false)}
          </text>
        ))}
        {/* Bars only make sense for one series; several would hide each other,
            so with more than one the chart falls back to lines. */}
        {type === 'bars' && single && (
          <>
            {single.points.map((p, i) => (
              <rect
                key={i}
                x={x(p.t) - barWidth / 2}
                y={Math.min(yOf(single)(p.v), zeroY)}
                width={barWidth}
                height={Math.max(1, Math.abs(yOf(single)(p.v) - zeroY))}
                fill={single.s.color}
                opacity={0.65}
              />
            ))}
            <line x1={pad.left} x2={width - pad.right} y1={zeroY} y2={zeroY} stroke="rgb(var(--fg-faint))" />
          </>
        )}
        {drawable.map(d => {
          if (type === 'bars' && single) return null;
          const y = yOf(d);
          const line = pathOf(d.points, y);
          const last = d.points[d.points.length - 1];
          return (
            <g key={d.s.field}>
              {type === 'area' && (
                <path d={`${line} L${x(last.t).toFixed(1)},${pad.top + h} L${x(d.points[0].t).toFixed(1)},${pad.top + h} Z`} fill={d.s.color} opacity={0.12} />
              )}
              {type === 'dots' ? (
                d.points.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.v)} r={2.5} fill={d.s.color} />)
              ) : (
                <path d={line} fill="none" stroke={d.s.color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
              )}
              {type !== 'dots' && <circle cx={x(last.t)} cy={y(last.v)} r="3" fill={d.s.color} stroke="rgb(var(--bg-1))" strokeWidth="1.5" />}
            </g>
          );
        })}
        {/* The message on screen: a filled dot, so it reads apart from the hover ring. */}
        {marked && single && (
          <g pointerEvents="none">
            <line x1={x(marked.t)} x2={x(marked.t)} y1={pad.top} y2={pad.top + h} stroke="rgb(var(--accent) / 0.5)" />
            <circle cx={x(marked.t)} cy={yOf(single)(marked.v)} r="5" fill="rgb(var(--accent))" stroke="rgb(var(--bg-1))" strokeWidth="2" />
          </g>
        )}
        {bandX && bandX[1] - bandX[0] > 1 && (
          <rect
            x={bandX[0]}
            y={pad.top}
            width={bandX[1] - bandX[0]}
            height={h}
            fill="rgb(var(--accent) / 0.15)"
            stroke="rgb(var(--accent) / 0.55)"
            pointerEvents="none"
          />
        )}
        {hoveredT !== null && !band && (
          <g pointerEvents="none">
            <line x1={x(hoveredT)} x2={x(hoveredT)} y1={pad.top} y2={pad.top + h} stroke="rgb(var(--fg-faint))" strokeDasharray="3 3" />
            {drawable.map(d => {
              const p = nearestIn(d.points, hoveredT);
              return <circle key={d.s.field} cx={x(p.t)} cy={yOf(d)(p.v)} r="3.5" fill="rgb(var(--bg-1))" stroke={d.s.color} strokeWidth="2" />;
            })}
          </g>
        )}
      </svg>
    </div>
  );
}
