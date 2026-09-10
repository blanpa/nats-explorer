import { useState } from 'react';
import { LineChart, RefreshCw, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { formatCount } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Select } from '../ui/Input';
import { Hint, Segmented } from '../ui/misc';
import ValueChart, { CHART_TYPES, colorForIndex, type ChartType } from '../subjects/ValueChart';
import { AGGREGATIONS, savedAgg, savedChartType, persistChartSettings, savedLayout, savedNormalize } from '../subjects/ChartPanel';

const RANGES = [500, 2000, 10_000, 50_000];

export interface ChartSpec {
  field: string;
  /** subject of the row the field was picked from; null charts every subject */
  subject: string | null;
  last: number;
}

/** A numeric field over the stream's last messages, read and downsampled by the backend. */
export default function StreamChart({
  connId,
  stream,
  spec,
  live,
  onChange,
  onClose,
}: {
  connId: string;
  stream: string;
  spec: ChartSpec;
  live: boolean;
  onChange: (s: ChartSpec) => void;
  onClose: () => void;
}) {
  // The same two choices as a subject chart: how to reduce a bucket, and
  // how to draw it. They share the stored settings, so a chart opens the way
  // the last one was left wherever it was opened.
  const [agg, setAggState] = useState(savedAgg);
  const [type, setTypeState] = useState<ChartType>(savedChartType);
  const store = (next: { agg?: typeof agg; type?: ChartType }) =>
    persistChartSettings({ agg: next.agg ?? agg, type: next.type ?? type, layout: savedLayout(), normalize: savedNormalize() });
  const setAgg = (a: typeof agg) => {
    store({ agg: a });
    setAggState(a);
  };
  const setType = (t: ChartType) => {
    store({ type: t });
    setTypeState(t);
  };
  const { data, error, loading, reload } = useAsync(
    () => api.getStreamSeries(connId, stream, { field: spec.field, subject: spec.subject ?? undefined, last: spec.last, points: 600, agg }),
    [connId, stream, spec.field, spec.subject, spec.last, agg],
    { interval: live ? 10_000 : undefined, key: `stream-series:${connId}:${stream}:${spec.field}:${spec.subject ?? '*'}:${spec.last}:${agg}` },
  );
  return (
    <div className="card mx-3 mt-2 px-3 py-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <LineChart size={13} className="text-accent" />
        <span className="font-mono text-fg">{spec.field}</span>
        <span className="text-faint">over the last</span>
        <Select
          inputSize="sm"
          className="w-28"
          value={spec.last}
          onChange={e => onChange({ ...spec, last: Number(e.target.value) })}
          aria-label="Messages to chart"
        >
          {RANGES.map(n => (
            <option key={n} value={n}>
              {formatCount(n)} msgs
            </option>
          ))}
        </Select>
        {spec.subject && (
          <Button
            size="xs"
            variant="outline"
            active
            onClick={() => onChange({ ...spec, subject: null })}
            title="Chart this field across every subject of the stream"
          >
            <span className="font-mono">{spec.subject}</span> <X size={11} />
          </Button>
        )}
        {data && (
          <span className="text-faint">
            {formatCount(data.samples)} values in seq {data.fromSeq}–{data.toSeq}
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <span className="inline-flex items-center gap-1">
            <Segmented size="xs" options={AGGREGATIONS.map(a => ({ id: a.id, label: a.label }))} value={agg} onChange={setAgg} />
            <Hint text={AGGREGATIONS.find(a => a.id === agg)?.hint ?? ''} />
          </span>
          <Segmented size="xs" options={CHART_TYPES} value={type} onChange={setType} />
          <IconButton label="Reload chart" size="xs" loading={loading && !!data} onClick={reload}>
            <RefreshCw size={12} />
          </IconButton>
          <IconButton label="Close chart" size="xs" onClick={onClose}>
            <X size={13} />
          </IconButton>
        </span>
      </div>
      {error ? (
        <div className="text-xs text-danger">{error}</div>
      ) : data ? (
        <ValueChart
          type={type}
          series={[
            {
              field: spec.field,
              color: colorForIndex(0),
              points: data.points.map(([t, v]) => ({ t, v })),
              info: { subject: data.subject ?? '', field: data.field, points: data.points, samples: data.samples, last: 0, agg: data.agg },
            },
          ]}
        />
      ) : (
        <div className="text-xs text-muted py-6 text-center">Reading the stream…</div>
      )}
    </div>
  );
}
