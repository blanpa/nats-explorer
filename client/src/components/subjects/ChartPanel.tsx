import { useMemo } from 'react';
import { X } from 'lucide-react';
import type { Aggregation, HistorySeries, NatsMessage } from 'shared';
import { readSetting, writeSetting } from '../../lib/utils';
import { Checkbox } from '../ui/Input';
import { IconButton } from '../ui/Button';
import { Segmented } from '../ui/misc';
import ValueChart, { CHART_TYPES, type ChartSeries, type ChartType, colorForIndex, mergePoints, type Point } from './ValueChart';

/**
 * Several fields at once. Two questions decide what the panel looks like,
 * and neither has one right answer, so both are the reader's:
 *
 *   - one chart or one per field. Overlaying compares shapes; separate
 *     charts each keep their own axis, which is the only honest way to show
 *     a temperature next to a counter.
 *   - which reduction. Every downsample throws something away; "what was the
 *     peak", "what was it on average" and "how fast is this climbing" are
 *     different questions about the same field.
 */

export const AGGREGATIONS: { id: Aggregation; label: string; hint: string }[] = [
  {
    id: 'minmax',
    label: 'Min/Max',
    hint: 'Both extremes of every bucket, so a spike between two samples still shows. The only one that never hides an outlier.',
  },
  { id: 'avg', label: 'Avg', hint: 'The mean of every bucket: the trend without the noise.' },
  { id: 'min', label: 'Min', hint: 'The lowest value of every bucket.' },
  { id: 'max', label: 'Max', hint: 'The highest value of every bucket.' },
  { id: 'sum', label: 'Sum', hint: 'The values of a bucket added up: for quantities per message, not for levels.' },
  { id: 'count', label: 'Count', hint: 'How many messages carried the field, which is about the traffic rather than the value.' },
  { id: 'rate', label: 'Rate/s', hint: 'The change per second: what a counter (parts, kWh, bytes) is actually doing. Its raw value is a staircase.' },
];

export type ChartLayout = 'overlay' | 'separate';

const TYPE_KEY = 'ne.chartType';
const LAYOUT_KEY = 'ne.chartLayout';
const AGG_KEY = 'ne.chartAgg';
const NORMALIZE_KEY = 'ne.chartNormalize';

function saved<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = readSetting<string>(key, fallback);
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export const savedChartType = () =>
  saved<ChartType>(
    TYPE_KEY,
    CHART_TYPES.map(t => t.id),
    'line',
  );
export const savedLayout = () => saved<ChartLayout>(LAYOUT_KEY, ['overlay', 'separate'], 'separate');
export const savedAgg = () =>
  saved<Aggregation>(
    AGG_KEY,
    AGGREGATIONS.map(a => a.id),
    'minmax',
  );
export const savedNormalize = () => readSetting<boolean>(NORMALIZE_KEY, true);

export interface ChartSettings {
  type: ChartType;
  layout: ChartLayout;
  agg: Aggregation;
  normalize: boolean;
}

interface Props {
  fields: string[];
  /** live messages of the subject; those newer than a series are appended */
  messages: NatsMessage[];
  /** what the server answered per field */
  seriesByField: Record<string, HistorySeries | null | undefined>;
  settings: ChartSettings;
  onSettings: (patch: Partial<ChartSettings>) => void;
  onRemove: (field: string) => void;
  onClear: () => void;
  onPick?: (point: Point, field: string) => void;
  marker?: Point | null;
}

export default function ChartPanel({ fields, messages, seriesByField, settings, onSettings, onRemove, onClear, onPick, marker }: Props) {
  const { type, layout, agg, normalize } = settings;

  const series: ChartSeries[] = useMemo(
    () =>
      fields.map((field, i) => ({
        field,
        color: colorForIndex(i),
        points: mergePoints(seriesByField[field], messages, field, agg),
        info: seriesByField[field],
      })),
    [fields, seriesByField, messages, agg],
  );

  if (fields.length === 0) return null;
  const many = fields.length > 1;
  const aggHint = AGGREGATIONS.find(a => a.id === agg)?.hint;

  return (
    <div className="card p-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted">Charting</span>
        {fields.map((f, i) => (
          <span key={f} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5">
            <span className="w-2 h-2 rounded-full" style={{ background: colorForIndex(i) }} aria-hidden />
            <span className="font-mono">{f}</span>
            <IconButton label={`Stop charting ${f}`} size="xs" onClick={() => onRemove(f)}>
              <X size={11} />
            </IconButton>
          </span>
        ))}
        {many && (
          <button type="button" className="text-faint hover:text-fg underline underline-offset-2" onClick={onClear}>
            clear all
          </button>
        )}

        <span className="ml-auto flex flex-wrap items-center gap-2">
          <span title={aggHint}>
            <Segmented size="xs" options={AGGREGATIONS.map(a => ({ id: a.id, label: a.label }))} value={agg} onChange={v => onSettings({ agg: v })} />
          </span>
          {many && (
            <Segmented
              size="xs"
              options={[
                { id: 'separate', label: 'Separate' },
                { id: 'overlay', label: 'One chart' },
              ]}
              value={layout}
              onChange={v => onSettings({ layout: v })}
            />
          )}
          <Segmented size="xs" options={CHART_TYPES} value={type} onChange={v => onSettings({ type: v })} />
        </span>
      </div>

      {aggHint && <p className="text-xs text-faint -mt-1">{aggHint}</p>}

      {many && layout === 'overlay' && (
        <Checkbox
          label="Scale each field to its own range"
          description="Fields with different units share one axis only if each is scaled to itself; the numbers above the chart stay the real ones. Off, they share the axis as they are, which is what comparable fields want."
          checked={normalize}
          onChange={e => onSettings({ normalize: e.target.checked })}
        />
      )}

      {layout === 'overlay' || !many ? (
        <ValueChart series={series} type={type} normalize={many && normalize} onPick={onPick} marker={many ? null : marker} height={many ? 200 : 160} />
      ) : (
        <div className="flex flex-col gap-2">
          {series.map(s => (
            <ValueChart key={s.field} series={[s]} type={type} onPick={onPick} marker={marker} height={130} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Stores the settings so a chart opens the way the last one was left. */
export function persistChartSettings(s: ChartSettings) {
  writeSetting(TYPE_KEY, s.type);
  writeSetting(LAYOUT_KEY, s.layout);
  writeSetting(AGG_KEY, s.agg);
  writeSetting(NORMALIZE_KEY, s.normalize);
}
