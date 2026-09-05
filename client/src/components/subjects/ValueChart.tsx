import { useEffect, useMemo, useRef, useState } from 'react';
import type { NatsMessage } from 'shared';
import { extractNumber, formatTime } from '../../lib/utils';

interface Point {
  t: number;
  v: number;
}

interface Props {
  messages: NatsMessage[];
  fieldPath: string;
  height?: number;
}

function niceNumber(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  const abs = Math.abs(v);
  return v.toFixed(abs >= 100 ? 1 : abs >= 1 ? 2 : 4);
}

export default function ValueChart({ messages, fieldPath, height = 160 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

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
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const tRange = Math.max(1, t1 - t0);
  const x = (t: number) => pad.left + ((t - t0) / tRange) * w;
  const y = (v: number) => pad.top + h - ((v - min) / (max - min)) * h;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(t1).toFixed(1)},${pad.top + h} L${x(t0).toFixed(1)},${pad.top + h} Z`;

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
      </div>
      <svg width={width} height={height} className="block" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="vc-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity="0.35" />
            <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity="0.02" />
          </linearGradient>
        </defs>
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
        <path d={area} fill="url(#vc-fill)" />
        <path d={line} fill="none" stroke="rgb(var(--accent))" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(latest.t)} cy={y(latest.v)} r="3" fill="rgb(var(--accent))" stroke="rgb(var(--bg-1))" strokeWidth="1.5" />
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
