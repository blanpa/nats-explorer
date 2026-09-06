import { useEffect, useMemo, useRef, useState } from 'react';
import type { NatsMessage } from 'shared';
import { extractNumber, formatTime, readSetting, writeSetting } from '../../lib/utils';
import { Segmented } from '../ui/misc';

interface Point {
  t: number;
  v: number;
}

interface Props {
  messages: NatsMessage[];
  fieldPath: string;
  height?: number;
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
  if (Number.isInteger(v)) return v.toLocaleString();
  const abs = Math.abs(v);
  return v.toFixed(abs >= 100 ? 1 : abs >= 1 ? 2 : 4);
}

export default function ValueChart({ messages, fieldPath, height = 160 }: Props) {
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

  const points = useMemo<Point[]>(() => {
    const out: Point[] = [];
    for (const m of messages) {
      if (m.payloadType !== 'json') continue;
      const v = extractNumber(m.payload, fieldPath);
      if (v !== null) out.push({ t: m.timestamp, v });
    }
    return out;
  }, [messages, fieldPath]);

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

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = t0 + ((px - pad.left) / w) * tRange;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].t - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };

  return (
    <div ref={wrapRef} className="w-full">
      <div className="flex items-baseline gap-3 mb-1 text-xs">
        <span className="font-mono text-syn-num">{fieldPath}</span>
        <span className="font-mono text-md font-semibold text-fg tabular-nums">{niceNumber(hovered ? hovered.v : latest.v)}</span>
        {!hovered && delta !== 0 && (
          <span className={delta > 0 ? 'text-ok' : 'text-danger'}>
            {delta > 0 ? '▲' : '▼'} {niceNumber(Math.abs(delta))}
          </span>
        )}
        {hovered && <span className="text-muted font-mono">{formatTime(hovered.t)}</span>}
        <span className="ml-auto text-faint font-mono tabular-nums">
          min {niceNumber(min)} · max {niceNumber(max)} · {points.length} pts
        </span>
        <Segmented size="xs" options={CHART_TYPES} value={type} onChange={setType} />
      </div>
      <svg width={width} height={height} className="block" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} stroke="rgb(var(--border))" strokeDasharray="2 4" />
            <text x={pad.left - 6} y={y(v) + 3} textAnchor="end" fontSize="10" fill="rgb(var(--fg-faint))" fontFamily="var(--font-mono)">
              {niceNumber(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} fontSize="10" fill="rgb(var(--fg-faint))" fontFamily="var(--font-mono)">
            {formatTime(t, false)}
          </text>
        ))}
        {type === 'bars' &&
          points.map((p, i) => {
            const top = Math.min(y(p.v), zeroY);
            const hgt = Math.max(1, Math.abs(y(p.v) - zeroY));
            return <rect key={i} x={x(p.t) - barWidth / 2} y={top} width={barWidth} height={hgt} fill={hover === i ? 'rgb(var(--accent))' : 'rgb(var(--accent) / 0.55)'} />;
          })}
        {type === 'bars' && <line x1={pad.left} x2={width - pad.right} y1={zeroY} y2={zeroY} stroke="rgb(var(--fg-faint))" />}
        {type === 'dots' && points.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.v)} r={2.5} fill="rgb(var(--accent))" />)}
        {type === 'area' && <path d={area} fill="rgb(var(--accent) / 0.12)" />}
        {(type === 'line' || type === 'area' || type === 'step') && (
          <path d={line} fill="none" stroke="rgb(var(--accent))" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
        )}
        {type !== 'bars' && <circle cx={x(latest.t)} cy={y(latest.v)} r="3" fill="rgb(var(--accent))" stroke="rgb(var(--bg-1))" strokeWidth="1.5" />}
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
