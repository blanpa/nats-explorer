import { useMemo, useState } from 'react';
import { Copy, RefreshCw, Table } from 'lucide-react';
import { api } from '../../lib/api';
import { columnsOf, stateCsv, stateRows } from '../../lib/stateTable';
import { delayOf, timeFieldsOf } from '../../lib/payloadTime';
import { useAsync } from '../../lib/useAsync';
import { useStore } from '../../store';
import { cn, copyToClipboard, formatDurationMs, formatTime, readSetting, writeSetting } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { Input } from '../ui/Input';
import { EmptyState, PaneHeader } from '../ui/misc';
import { toast } from '../ui/Toast';

const REFRESH_MS = 5000;
/** Messages read per root; the newest one per subject is what survives. */
const LIMIT = 5000;
const ROOT_KEY = 'ne.stateRoot';

/**
 * The current state of every subject, side by side.
 *
 * A message list answers "what was sent". In front of a running plant the
 * question is "what is it": the newest value of every sensor, every setpoint
 * and every counter at once, with its age next to it. That is a table, not a
 * stream -- and the age column is the point, because a row that has not
 * moved in an hour is the one worth looking at.
 */
export default function StateView() {
  const connId = useStore(s => s.activeConnId) ?? undefined;
  const connections = useStore(s => s.connections);
  const revealSubject = useStore(s => s.revealSubject);
  const [root, setRoot] = useState(() => readSetting(ROOT_KEY, ''));
  const [filter, setFilter] = useState('');
  const [byAge, setByAge] = useState(false);

  // The roots worth offering: the first token of every subscription that is
  // not a system topic, which is where a UNS lives.
  const roots = useMemo(() => {
    const out = new Set<string>();
    for (const c of connections) {
      for (const p of c.subscriptions ?? []) {
        const head = p.split('.')[0];
        if (head && head !== '>' && !head.startsWith('$')) out.add(head);
      }
    }
    return [...out].sort();
  }, [connections]);
  const effective = root || roots[0] || '';

  const { data, loading, reload } = useAsync(
    async () => (effective ? (await api.getHistory(effective, { connId, limit: 1, branchLimit: LIMIT })).branch : []),
    [effective, connId],
    { interval: REFRESH_MS, key: effective ? `state:${connId ?? ''}:${effective}` : undefined },
  );

  const rows = useMemo(() => stateRows(data ?? []), [data]);
  const columns = useMemo(() => columnsOf(rows), [rows]);
  // Where a payload carries the producer's own clock, the difference to its
  // arrival is that producer's skew plus the network. A negative one is a
  // clock running ahead, which is a problem and not a fast network.
  const skews = useMemo(() => {
    const out = new Map<string, number>();
    for (const r of rows) {
      const field = timeFieldsOf(r.message)[0];
      const delay = field ? delayOf(r.message, field) : null;
      if (delay !== null) out.set(r.subject, delay);
    }
    return out;
  }, [rows]);
  const anySkew = skews.size > 0;
  const now = Date.now();
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? rows.filter(r => r.subject.toLowerCase().includes(q) || Object.values(r.fields).some(v => v.toLowerCase().includes(q))) : rows;
    return byAge ? [...list].sort((a, b) => a.at - b.at) : list;
  }, [rows, filter, byAge]);

  const copy = async () => {
    if (await copyToClipboard(stateCsv(shown, columns))) toast.success(`${shown.length} rows copied as CSV`);
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <PaneHeader title="State">
        <span className="text-xs text-faint truncate">The newest message of every subject, with its age</span>
        <div className="ml-auto flex items-center gap-2">
          <Input
            inputSize="sm"
            className="w-40"
            mono
            list="state-roots"
            value={effective}
            onChange={e => {
              setRoot(e.target.value);
              writeSetting(ROOT_KEY, e.target.value);
            }}
            placeholder="root subject"
            aria-label="Root subject"
          />
          <datalist id="state-roots">
            {roots.map(r => (
              <option key={r} value={r} />
            ))}
          </datalist>
          <Input inputSize="sm" className="w-48" placeholder="Filter…" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter state" />
          <IconButton label="Copy as CSV" size="sm" onClick={copy}>
            <Copy size={13} />
          </IconButton>
          <IconButton label="Reload" size="sm" onClick={reload}>
            <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
          </IconButton>
        </div>
      </PaneHeader>

      {shown.length === 0 ? (
        <EmptyState
          icon={Table}
          title={effective ? 'Nothing recorded under this root' : 'No subject root yet'}
          description={
            effective
              ? `No messages below ${effective} are in the recorded history. Pick another root, or subscribe to one.`
              : 'Name the root of the subjects to watch — the first token, like uns or plant. The roots of the current subscriptions are offered.'
          }
        />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Subject</th>
                {columns.map(c => (
                  <th key={c} className="num">
                    {c}
                  </th>
                ))}
                {anySkew && (
                  <th
                    className="num w-24"
                    title="The gap between the producer's own timestamp and the moment the message arrived. Negative means that producer's clock runs ahead."
                  >
                    Clock
                  </th>
                )}
                <th className="num w-28">
                  <button type="button" className="hover:text-fg" onClick={() => setByAge(a => !a)} title="Sort by age, oldest first">
                    Age{byAge ? ' ↓' : ''}
                  </button>
                </th>
                <th className="w-24">Last</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => {
                const age = now - r.at;
                const skew = skews.get(r.subject);
                return (
                  <tr key={r.subject} className="cursor-pointer" onClick={() => revealSubject(r.subject)} title={`Open ${r.subject}`}>
                    <td className="font-mono truncate max-w-[420px]">{r.subject}</td>
                    {columns.map(c => (
                      <td key={c} className="num font-mono">
                        {r.fields[c] ?? <span className="text-faint">–</span>}
                      </td>
                    ))}
                    {anySkew && (
                      <td className={cn('num font-mono', skew !== undefined && (skew < 0 || skew > 5000) && 'text-warn')}>
                        {skew === undefined ? <span className="text-faint">–</span> : `${skew < 0 ? '−' : ''}${formatDurationMs(Math.abs(skew))}`}
                      </td>
                    )}
                    {/* The age is why this table exists: a value is only as
                        good as the moment it arrived. */}
                    <td className={cn('num font-mono', age > 60_000 && 'text-warn', age > 600_000 && 'text-danger')}>{formatDurationMs(age)}</td>
                    <td className="font-mono text-faint">{formatTime(r.at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
