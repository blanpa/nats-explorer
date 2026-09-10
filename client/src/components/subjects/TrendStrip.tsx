import { useMemo } from 'react';
import type { NatsMessage } from 'shared';
import { cn, extractNumber, tryParseJson } from '../../lib/utils';

const MAX_FIELDS = 6;
const W = 88;
const H = 22;

function fieldsOf(payload: string): string[] {
  const doc = tryParseJson(payload);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
  return Object.entries(doc as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k]) => k)
    .slice(0, MAX_FIELDS);
}

function Sparkline({ values }: { values: number[] }) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const step = W / Math.max(1, values.length - 1);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(H - 2 - ((v - min) / (max - min)) * (H - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} className="block shrink-0" aria-hidden>
      <path d={d} fill="none" stroke="rgb(var(--accent))" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The numeric top-level fields of the latest JSON message as sparklines over
 * the buffered history. Clicking one opens the full chart for that field.
 */
export default function TrendStrip({
  messages,
  latest,
  selected,
  onSelect,
}: {
  messages: NatsMessage[];
  latest: NatsMessage;
  /** fields currently charted; a card of one is marked */
  selected: string[];
  onSelect: (field: string) => void;
}) {
  const trends = useMemo(() => {
    if (latest.payloadType !== 'json' || messages.length < 3) return [];
    const recent = messages.length > 120 ? messages.slice(messages.length - 120) : messages;
    return fieldsOf(latest.payload)
      .map(field => {
        const values: number[] = [];
        for (const m of recent) {
          if (m.payloadType !== 'json') continue;
          const v = extractNumber(m.payload, field);
          if (v !== null) values.push(v);
        }
        return { field, values, current: extractNumber(latest.payload, field) };
      })
      .filter(t => t.values.length >= 3);
  }, [messages, latest]);

  if (trends.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {trends.map(t => (
        <button
          key={t.field}
          type="button"
          className={cn(
            'card flex items-center gap-3 px-3 py-1.5 text-left hover:border-accent/50 transition-colors',
            selected.includes(t.field) && 'border-accent/60',
          )}
          onClick={() => onSelect(t.field)}
          title={selected.includes(t.field) ? `Stop charting ${t.field}` : `Chart ${t.field}`}
        >
          <span className="min-w-0">
            <span className="block text-xs text-muted font-mono truncate">{t.field}</span>
            <span className="block text-sm font-mono text-syn-num tabular-nums">{t.current}</span>
          </span>
          <Sparkline values={t.values} />
        </button>
      ))}
    </div>
  );
}
