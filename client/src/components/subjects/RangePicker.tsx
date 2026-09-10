import { CalendarClock, X } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../../lib/utils';
import { useStore } from '../../store';
import { Button, IconButton } from '../ui/Button';
import { Input } from '../ui/Input';

export interface TimeRange {
  from: number;
  to: number;
  label: string;
}

const PRESETS: { label: string; minutes: number }[] = [
  { label: '15 min', minutes: 15 },
  { label: '1 h', minutes: 60 },
  { label: '6 h', minutes: 360 },
  { label: '24 h', minutes: 1440 },
  { label: '7 d', minutes: 10080 },
];

const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};

/**
 * Picks a time range of the persistent history: presets reaching back from
 * now, or a custom start and end. Only rendered when the backend keeps a
 * database.
 */
export default function RangePicker({ range, onChange }: { range: TimeRange | null; onChange: (r: TimeRange | null) => void }) {
  const historyDb = useStore(s => s.historyDb);
  const retention = useStore(s => s.historyRetention);
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState(() => toLocalInput(Date.now() - 3600_000));
  const [to, setTo] = useState(() => toLocalInput(Date.now()));
  if (!historyDb) return null;

  const pick = (minutes: number, label: string) => {
    setCustom(false);
    onChange({ from: Date.now() - minutes * 60_000, to: Date.now(), label });
  };
  const applyCustom = () => {
    const f = new Date(from).getTime();
    const t = new Date(to).getTime();
    if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) return;
    onChange({ from: f, to: t, label: `${new Date(f).toLocaleString()} – ${new Date(t).toLocaleString()}` });
  };

  return (
    <div className="flex flex-wrap items-center gap-1" title={`Persistent history, retention ${retention}`}>
      <CalendarClock size={13} className="text-muted mr-0.5" />
      <button type="button" className={cn('btn btn-xs', range === null ? 'btn-primary' : 'btn-outline')} onClick={() => onChange(null)}>
        Live
      </button>
      {PRESETS.map(p => (
        <button
          key={p.label}
          type="button"
          className={cn('btn btn-xs', range?.label === p.label ? 'btn-primary' : 'btn-outline')}
          onClick={() => pick(p.minutes, p.label)}
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        className={cn('btn btn-xs', custom || (range && !PRESETS.some(p => p.label === range.label)) ? 'btn-primary' : 'btn-outline')}
        onClick={() => setCustom(c => !c)}
      >
        Custom
      </button>
      {custom && (
        <form
          className="flex items-center gap-1"
          onSubmit={e => {
            e.preventDefault();
            applyCustom();
          }}
        >
          <Input inputSize="sm" type="datetime-local" className="w-44" value={from} onChange={e => setFrom(e.target.value)} aria-label="Range start" />
          <span className="text-faint text-xs">to</span>
          <Input inputSize="sm" type="datetime-local" className="w-44" value={to} onChange={e => setTo(e.target.value)} aria-label="Range end" />
          <Button size="xs" type="submit">
            Apply
          </Button>
          <IconButton label="Close custom range" size="xs" onClick={() => setCustom(false)}>
            <X size={12} />
          </IconButton>
        </form>
      )}
    </div>
  );
}
