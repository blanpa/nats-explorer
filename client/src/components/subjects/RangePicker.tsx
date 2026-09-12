import { CalendarClock, ChevronLeft, ChevronRight, X, ZoomOut } from 'lucide-react';
import { useState } from 'react';
import { cn, formatDateTime, formatDurationMs, formatTime, parseGoDuration } from '../../lib/utils';
import { useStore } from '../../store';
import { Button, IconButton } from '../ui/Button';
import { Input } from '../ui/Input';

export interface TimeRange {
  from: number;
  to: number;
  /** Short, for the button and the badge: "1 h", "All". */
  label: string;
  /**
   * How the range reads in a sentence. "the last 1 h" works for a preset
   * reaching back from now; "the last All" does not, and neither does "the
   * last 10.9.2026 - 11.9.2026".
   */
  prose: string;
}

const PRESETS: { label: string; minutes: number; prose?: string }[] = [
  { label: '15 min', minutes: 15 },
  { label: '1 h', minutes: 60 },
  { label: '6 h', minutes: 360 },
  { label: '24 h', minutes: 1440 },
  { label: '7 d', minutes: 10080 },
  { label: '30 d', minutes: 43200 },
  // Everything the database still holds. With no retention that is every
  // message ever recorded, and a preset is the only way to ask for it
  // without typing a start date.
  { label: 'All', minutes: 0, prose: 'the recorded history' },
];

/**
 * A window with a start and an end, named the way it reads back: two clock
 * times while it stays inside one day, dates as well once it crosses one.
 * This is what a drag across a chart and the custom form both produce, so
 * both are shown, and re-shown, in the same words.
 */
export function windowRange(from: number, to: number): TimeRange {
  const start = Math.max(0, Math.round(from));
  const end = Math.round(to);
  const oneDay = new Date(start).toDateString() === new Date(end).toDateString();
  const at = (ms: number) => (oneDay ? formatTime(ms, false) : formatDateTime(ms));
  const label = `${at(start)} – ${at(end)}`;
  return { from: start, to: end, label, prose: label };
}

/** A zero retention means nothing is deleted; "retention 0s" would not say that. */
function retentionLabel(retention: string): string {
  const forever = retention === '' || parseGoDuration(retention) === 0;
  return forever ? 'Persistent history, every message kept' : `Persistent history, retention ${retention}`;
}

// Seconds and all: a window dragged out of a chart is rarely a round
// minute, and rounding it away on the way into the form would move it.
const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 19);
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

  const pick = (p: { label: string; minutes: number; prose?: string }) => {
    setCustom(false);
    onChange({
      from: p.minutes === 0 ? 0 : Date.now() - p.minutes * 60_000,
      to: Date.now(),
      label: p.label,
      prose: p.prose ?? `the last ${p.label}`,
    });
  };
  const applyCustom = () => {
    const f = new Date(from).getTime();
    const t = new Date(to).getTime();
    if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) return;
    onChange(windowRange(f, t));
  };

  /**
   * The form always opens on what is on screen, whichever way it was chosen:
   * the window dragged out of a chart, the preset that is selected, or the
   * last hour while the view is live. It used to open on the last hour as it
   * stood when the page was loaded -- on a tab that had been open since the
   * morning, clicking Custom offered a window from the morning.
   *
   * "All" reaches back to wherever the database begins, which is not a time
   * the browser knows; there the last hour of it is the honest offer.
   */
  const toggleCustom = () => {
    if (!custom) {
      const end = range ? range.to : Date.now();
      setFrom(toLocalInput(range && range.from > 0 ? range.from : end - 3600_000));
      setTo(toLocalInput(end));
    }
    setCustom(c => !c);
  };

  /**
   * Moves the window without changing how wide it is, and never past now:
   * a window over the future is empty, and an empty chart is not an answer.
   */
  const move = (nextFrom: number, nextTo: number) => {
    const now = Date.now();
    const over = Math.max(0, nextTo - now);
    onChange(windowRange(nextFrom - over, nextTo - over));
  };
  const span = range ? range.to - range.from : 0;
  // A window with a start can be zoomed and panned; "All" has none.
  const zoomable = !!range && range.from > 0 && span > 0;
  // A window that is not one of the presets was dragged out of a chart or
  // typed into the form. Nothing in this row said which one it was -- the
  // reader had to open the form to find out what they were looking at -- so
  // it is named here, where it was chosen.
  const picked = range && !PRESETS.some(p => p.label === range.label) ? range : null;

  return (
    <div className="flex flex-wrap items-center gap-1" title={retentionLabel(retention)}>
      <CalendarClock size={13} className="text-muted mr-0.5" />
      <button type="button" className={cn('btn btn-xs', range === null ? 'btn-primary' : 'btn-outline')} onClick={() => onChange(null)}>
        Live
      </button>
      {PRESETS.map(p => (
        <button key={p.label} type="button" className={cn('btn btn-xs', range?.label === p.label ? 'btn-primary' : 'btn-outline')} onClick={() => pick(p)}>
          {p.label}
        </button>
      ))}
      <button type="button" className={cn('btn btn-xs', custom || picked ? 'btn-primary' : 'btn-outline')} onClick={toggleCustom}>
        Custom
      </button>
      {picked && !custom && (
        <span
          className="text-xs text-muted font-mono tabular-nums whitespace-nowrap ml-0.5"
          title="The window on screen. Drag across a chart for another one, or Custom to type it."
        >
          {picked.label}
        </span>
      )}
      {/* Zooming out and stepping sideways only exist once a window does, so
          they appear at the end of the row, where nothing has to move for
          them. */}
      {zoomable && (
        <span className="flex items-center gap-1 ml-1">
          <IconButton label="Earlier window" size="xs" onClick={() => move(range.from - span / 2, range.to - span / 2)}>
            <ChevronLeft size={13} />
          </IconButton>
          <IconButton label="Zoom out" size="xs" onClick={() => move(range.from - span / 2, range.to + span / 2)}>
            <ZoomOut size={13} />
          </IconButton>
          <IconButton label="Later window" size="xs" onClick={() => move(range.from + span / 2, range.to + span / 2)}>
            <ChevronRight size={13} />
          </IconButton>
          <span className="text-xs text-faint font-mono tabular-nums whitespace-nowrap">{formatDurationMs(span)}</span>
        </span>
      )}
      {custom && (
        <form
          className="flex items-center gap-1"
          onSubmit={e => {
            e.preventDefault();
            applyCustom();
          }}
        >
          <Input inputSize="sm" type="datetime-local" step="1" className="w-48" value={from} onChange={e => setFrom(e.target.value)} aria-label="Range start" />
          <span className="text-faint text-xs">to</span>
          <Input inputSize="sm" type="datetime-local" step="1" className="w-48" value={to} onChange={e => setTo(e.target.value)} aria-label="Range end" />
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
