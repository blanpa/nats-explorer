import { useEffect, useMemo, useState } from 'react';
import { Timer } from 'lucide-react';
import type { NatsMessage } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { latencyBuckets, sharedFields, stepLatency } from '../../lib/stepLatency';
import { formatDurationMs, formatNumber, formatTime } from '../../lib/utils';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Input';
import { EmptyState, StatStrip, StatTile } from '../ui/misc';
import LatencyHistogram from '../requests/LatencyHistogram';

/** How many messages of each side are read; more than this is a report, not a look. */
const LIMIT = 2000;

/**
 * How long the step from one subject to another takes.
 *
 * A service's request/reply latency is visible everywhere. The hop between
 * two published messages -- `orders.created` to `orders.paid`, a reading to
 * the alarm it raises -- is not, and it is the one the business asks about.
 * Both messages carry the same id somewhere, so the recorded history already
 * holds the answer; this pairs them by that value and shows the spread.
 *
 * The headline is not the median. It is how many of the first messages never
 * produced a second one.
 */
export default function StepLatencyDialog({ subject, onClose }: { subject: string; onClose: () => void }) {
  const connId = useStore(s => s.activeConnId) ?? undefined;
  const revealSubject = useStore(s => s.revealSubject);
  const [to, setTo] = useState('');
  const [field, setField] = useState('');
  const [sides, setSides] = useState<{ from: NatsMessage[]; to: NatsMessage[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState(false);

  const load = async () => {
    const target = to.trim();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const [a, b] = await Promise.all([api.getHistory(subject, { connId, limit: LIMIT }), api.getHistory(target, { connId, limit: LIMIT })]);
      setSides({ from: a.messages, to: b.messages });
      setRan(true);
    } catch (err) {
      setError(errorMessage(err));
      setSides(null);
    } finally {
      setBusy(false);
    }
  };

  // The field both sides carry, picked once the messages are in.
  const candidates = useMemo(() => (sides ? sharedFields(sides.from, sides.to) : []), [sides]);
  useEffect(() => {
    if (!field && candidates.length) setField(candidates[0]);
  }, [candidates, field]);

  const result = useMemo(() => (sides && field ? stepLatency(sides.from, sides.to, field) : null), [sides, field]);
  const buckets = useMemo(() => (result ? latencyBuckets(result.pairs.map(p => p.deltaMs)) : []), [result]);

  return (
    <Dialog
      open
      onOpenChange={o => !o && onClose()}
      title="Time to another subject"
      description={`Pairs the messages of ${subject} with a later subject by a value both carry, and measures the gap.`}
      width="lg"
      footer={
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={busy} disabled={!to.trim()} onClick={load}>
            Measure
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 min-h-0">
        <div className="grid grid-cols-2 gap-3">
          <Field label="From" hint="The subject this dialog was opened on.">
            <Input mono value={subject} readOnly />
          </Field>
          <Field label="To" hint="The subject the chain continues on. One concrete subject, not a pattern.">
            <Input
              mono
              autoFocus
              value={to}
              onChange={e => setTo(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load()}
              placeholder="orders.paid"
              aria-label="Target subject"
            />
          </Field>
        </div>
        {candidates.length > 0 && (
          <Field label="Paired by" hint="A value both messages carry: an order id, a correlation id, a header. The fields found on both sides are offered.">
            <Input mono list="step-latency-fields" value={field} onChange={e => setField(e.target.value)} aria-label="Correlation field" />
            <datalist id="step-latency-fields">
              {candidates.map(c => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        {result && result.pairs.length > 0 ? (
          <div className="flex flex-col gap-3 min-h-0">
            <StatStrip>
              <StatTile label="Pairs" value={formatNumber(result.pairs.length)} />
              <StatTile
                label="Never arrived"
                value={formatNumber(result.unfinished)}
                tone={result.unfinished > 0 ? 'danger' : undefined}
                sub={`of ${formatNumber(result.pairs.length + result.unfinished)} started`}
              />
              <StatTile label="p50" value={formatDurationMs(result.p50)} />
              <StatTile label="p95" value={formatDurationMs(result.p95)} />
              <StatTile label="p99" value={formatDurationMs(result.p99)} />
              <StatTile label="max" value={formatDurationMs(result.max)} sub={`min ${formatDurationMs(result.min)}`} />
            </StatStrip>
            <LatencyHistogram buckets={buckets} />
            <div>
              <p className="text-xs text-muted mb-1">
                The slowest, worst first
                {result.orphans > 0 && ` · ${formatNumber(result.orphans)} message(s) on ${to.trim()} had nothing before them`}
              </p>
              <div className="max-h-56 overflow-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{field}</th>
                      <th className="num">Took</th>
                      <th>From</th>
                      <th>To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.pairs.slice(0, 20).map(p => (
                      <tr key={`${p.value}-${p.from}`}>
                        <td className="font-mono truncate max-w-[220px]">{p.value}</td>
                        <td className="num">{formatDurationMs(p.deltaMs)}</td>
                        <td className="font-mono text-muted">{formatTime(p.from)}</td>
                        <td className="font-mono text-muted">{formatTime(p.to)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <button type="button" className="text-xs text-accent self-start" onClick={() => revealSubject(to.trim())}>
              Open {to.trim()}
            </button>
          </div>
        ) : ran && !busy ? (
          <EmptyState
            compact
            icon={Timer}
            title={result && result.orphans > 0 ? 'Nothing pairs up' : 'No pairs found'}
            description={
              !field
                ? 'The two subjects carry no field in common, so there is nothing to pair them by.'
                : `No message on ${subject} shares its ${field} with a later one on ${to.trim()}. Either the chain uses another value, or the recorded history does not hold both ends.`
            }
          />
        ) : null}
      </div>
    </Dialog>
  );
}
