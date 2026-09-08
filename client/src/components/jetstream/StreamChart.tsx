import { LineChart, RefreshCw, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { formatCount } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Select } from '../ui/Input';
import ValueChart from '../subjects/ValueChart';

const RANGES = [500, 2000, 10_000, 50_000];
const NO_MESSAGES: never[] = [];

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
  const { data, error, loading, reload } = useAsync(
    () => api.getStreamSeries(connId, stream, { field: spec.field, subject: spec.subject ?? undefined, last: spec.last, points: 600 }),
    [connId, stream, spec.field, spec.subject, spec.last],
    { interval: live ? 10_000 : undefined, key: `stream-series:${connId}:${stream}:${spec.field}:${spec.subject ?? '*'}:${spec.last}` },
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
        <span className="ml-auto flex items-center gap-1">
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
          messages={NO_MESSAGES}
          series={{ subject: data.subject ?? '', field: data.field, points: data.points, samples: data.samples, last: 0 }}
          fieldPath={spec.field}
        />
      ) : (
        <div className="text-xs text-muted py-6 text-center">Reading the stream…</div>
      )}
    </div>
  );
}
