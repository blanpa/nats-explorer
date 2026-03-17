import { useMemo } from 'react';
import { NatsMessage } from '../../store';

interface DataPoint {
  time: number;
  value: number;
}

interface Props {
  messages: NatsMessage[];
  fieldPath: string;
  height?: number;
}

function extractValue(payload: string, path: string): number | null {
  try {
    let obj = JSON.parse(payload);
    const parts = path.split('.');
    for (const part of parts) {
      if (obj == null) return null;
      if (Array.isArray(obj)) {
        const idx = parseInt(part);
        if (isNaN(idx)) return null;
        obj = obj[idx];
      } else {
        obj = obj[part];
      }
    }
    return typeof obj === 'number' ? obj : null;
  } catch {
    return null;
  }
}

export default function ValueChart({ messages, fieldPath, height = 120 }: Props) {
  const dataPoints = useMemo(() => {
    const points: DataPoint[] = [];
    for (const msg of messages) {
      if (msg.payloadType !== 'json') continue;
      const val = extractValue(msg.payload, fieldPath);
      if (val !== null) {
        points.push({ time: msg.timestamp, value: val });
      }
    }
    return points;
  }, [messages, fieldPath]);

  if (dataPoints.length < 2) {
    return (
      <div className="chart-empty">
        Waiting for data points... ({dataPoints.length}/2)
      </div>
    );
  }

  const values = dataPoints.map(d => d.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;
  const minTime = dataPoints[0].time;
  const maxTime = dataPoints[dataPoints.length - 1].time;
  const timeRange = maxTime - minTime || 1;

  const padding = { top: 20, right: 12, bottom: 28, left: 52 };
  const width = 600;
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // Build SVG path
  const points = dataPoints.map(d => ({
    x: padding.left + ((d.time - minTime) / timeRange) * chartW,
    y: padding.top + chartH - ((d.value - minVal) / range) * chartH,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  // Area fill path
  const areaPath = linePath +
    ` L${points[points.length - 1].x.toFixed(1)},${padding.top + chartH}` +
    ` L${points[0].x.toFixed(1)},${padding.top + chartH} Z`;

  // Y-axis labels (5 ticks)
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const val = minVal + (range * i) / 4;
    const y = padding.top + chartH - (chartH * i) / 4;
    return { val, y };
  });

  // X-axis time labels
  const xTickCount = Math.min(5, dataPoints.length);
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const idx = Math.floor((i / (xTickCount - 1)) * (dataPoints.length - 1));
    const d = dataPoints[idx];
    const x = padding.left + ((d.time - minTime) / timeRange) * chartW;
    const t = new Date(d.time);
    return { x, label: `${t.getHours()}:${t.getMinutes().toString().padStart(2, '0')}:${t.getSeconds().toString().padStart(2, '0')}` };
  });

  const latestValue = values[values.length - 1];
  const prevValue = values.length > 1 ? values[values.length - 2] : latestValue;
  const delta = latestValue - prevValue;

  return (
    <div className="chart-container">
      <div className="chart-header">
        <span className="chart-field-path">{fieldPath}</span>
        <span className="chart-current-value">
          {latestValue.toFixed(latestValue % 1 === 0 ? 0 : 2)}
          {delta !== 0 && (
            <span className={delta > 0 ? 'chart-delta-up' : 'chart-delta-down'}>
              {delta > 0 ? '\u25B2' : '\u25BC'}{Math.abs(delta).toFixed(2)}
            </span>
          )}
        </span>
        <span className="chart-range">
          min: {minVal.toFixed(2)} | max: {maxVal.toFixed(2)} | {dataPoints.length} points
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4EC9B0" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#4EC9B0" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Grid lines */}
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={padding.left} y1={tick.y}
              x2={width - padding.right} y2={tick.y}
              className="chart-grid"
            />
            <text x={padding.left - 4} y={tick.y + 3} className="chart-label-y">
              {tick.val.toFixed(tick.val % 1 === 0 ? 0 : 1)}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {xTicks.map((tick, i) => (
          <text key={i} x={tick.x} y={height - 4} className="chart-label-x">
            {tick.label}
          </text>
        ))}

        {/* Area fill */}
        <path d={areaPath} className="chart-area" />

        {/* Line */}
        <path d={linePath} className="chart-line" />

        {/* Latest point */}
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r="3"
          className="chart-dot"
        />
      </svg>
    </div>
  );
}
