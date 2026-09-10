import { useState } from 'react';
import { Database, HardDrive } from 'lucide-react';
import type { HistoryPersistence } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useCanWrite } from '../../lib/auth';
import { useAsync } from '../../lib/useAsync';
import { formatBytes, formatDateTime, formatNumber } from '../../lib/utils';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Checkbox, Field, Input, Select } from '../ui/Input';
import { Badge, ErrorState, KeyValueGrid, LoadingState, SectionTitle } from '../ui/misc';
import { toast } from '../ui/Toast';

/** Retentions offered for the persistent history, as Go durations. */
const RETENTIONS = [
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '24h', label: '24 hours' },
  { value: '72h', label: '3 days' },
  { value: '168h', label: '7 days' },
  { value: '720h', label: '30 days' },
];

/** Seconds in a Go duration string like "72h0m0s"; 0 when it cannot be read. */
export function parseGoDuration(d: string): number {
  const units: Record<string, number> = { ns: 1e-9, µs: 1e-6, us: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };
  let total = 0;
  for (const [, num, unit] of d.matchAll(/(\d+(?:\.\d+)?)(ns|µs|us|ms|h|m|s)/g)) total += Number(num) * units[unit];
  return total;
}

/** Write buffers offered, in bytes. Bigger absorbs a longer burst and costs that much RAM. */
const BUFFERS = [
  { value: 16 << 20, label: '16 MB' },
  { value: 64 << 20, label: '64 MB (default)' },
  { value: 256 << 20, label: '256 MB' },
  { value: 1024 << 20, label: '1 GB' },
];

/** The option matching a duration from the backend, or the raw value when it is not one of ours. */
function retentionValue(d: string): string {
  const hours = parseGoDuration(d) / 3600;
  return RETENTIONS.find(r => Number.parseFloat(r.value) === hours)?.value ?? d;
}

/** The editable part of the setting. */
interface Form {
  enabled: boolean;
  retention: string;
  fullText: boolean;
  filter: string;
  queueBytes: number;
}

/** What the backend reports, as the form sees it. */
function formOf(data: HistoryPersistence): Form {
  return {
    enabled: data.enabled,
    retention: retentionValue(data.retention),
    fullText: data.fullText !== false,
    filter: data.filter ?? '',
    queueBytes: data.queueBytes || 64 << 20,
  };
}

function HistorySection() {
  const canWrite = useCanWrite();
  const setHistoryDb = useStore(s => s.setHistoryDb);
  const { data, error, initial, loading, reload, setData } = useAsync<HistoryPersistence>(() => api.getHistoryPersistence(), [], {
    interval: 5000,
  });
  // Until the user touches something the form is what the backend reports,
  // so the polled refresh does not fight an edit and nothing flashes while
  // the first answer arrives.
  const [edit, setEdit] = useState<Form | null>(null);
  const [purge, setPurge] = useState(false);
  const [saving, setSaving] = useState(false);

  if (initial && loading) return <LoadingState label="Reading the history setting…" />;
  if (!data) return <ErrorState message={error ?? 'The history setting could not be read.'} />;

  const current = formOf(data);
  const { enabled, retention, fullText, filter, queueBytes } = edit ?? current;
  const set = (patch: Partial<Form>) => setEdit({ ...(edit ?? current), ...patch });

  const editable = data.supported && !data.managed && canWrite;
  const changedWhileOn =
    enabled && (retention !== current.retention || fullText !== current.fullText || filter !== current.filter || queueBytes !== current.queueBytes);
  const changed = enabled !== data.enabled || changedWhileOn || (!enabled && purge);

  const save = async () => {
    setSaving(true);
    try {
      const next = await api.setHistoryPersistence({ enabled, retention, fullText, filter, queueBytes, purge: !enabled && purge });
      setData(next);
      setHistoryDb(next.enabled, next.retention);
      setPurge(false);
      setEdit(null);
      toast.success(next.enabled ? 'History is kept on disk' : 'History is memory-only again');
    } catch (err) {
      toast.error('Setting not saved', errorMessage(err));
      reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle
        actions={
          data.enabled ? (
            <Badge tone="ok">
              <Database size={11} /> On disk
            </Badge>
          ) : (
            <Badge tone="neutral">Memory only</Badge>
          )
        }
      >
        Message history
      </SectionTitle>

      <p className="text-sm text-muted">
        Received messages are always kept in memory, where a restart empties them. With a copy on disk the history survives a restart and the range picker can
        reach back further than memory.
      </p>

      {!data.supported ? (
        <p className="text-sm text-warn">{data.reason}</p>
      ) : (
        <>
          <Checkbox
            label="Keep the history on disk"
            description="Every received message is also written to a SQLite file next to the other settings."
            checked={enabled}
            disabled={!editable || saving}
            onChange={e => set({ enabled: e.target.checked })}
          />
          {enabled && (
            <Field label="Keep messages for" hint="Older messages are deleted once a minute.">
              <Select value={retention} disabled={!editable || saving} onChange={e => set({ retention: e.target.value })}>
                {RETENTIONS.every(r => r.value !== retention) && <option value={retention}>{data.retention}</option>}
                {RETENTIONS.map(r => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {enabled && (
            <Checkbox
              label="Full-text index for the search"
              description="Indexes every word of every stored message. Without it a search over the persistent history scans instead, and writing is several times faster -- worth switching off on a busy subject space."
              checked={fullText}
              disabled={!editable || saving}
              onChange={e => set({ fullText: e.target.checked })}
            />
          )}
          {enabled && (
            <Field
              label="Only write messages matching"
              hint="A CEL expression over subject, payload, headers, size and kind -- the same language as the payload filter. Empty writes everything. Excluding what is never searched for is the one setting that lowers the write rate itself, so it is the first thing to reach for when messages are not being persisted."
            >
              <Input
                mono
                placeholder='e.g. subject.startsWith("orders.") || size > 1024'
                value={filter}
                disabled={!editable || saving}
                onChange={e => set({ filter: e.target.value })}
              />
            </Field>
          )}
          {enabled && (
            <Field
              label="Write buffer"
              hint="How much of a burst is held in memory while the disk catches up. Above it messages are dropped from the disk copy -- never from the live view."
            >
              <Select value={String(queueBytes)} disabled={!editable || saving} onChange={e => set({ queueBytes: Number(e.target.value) })}>
                {BUFFERS.every(b => b.value !== queueBytes) && <option value={queueBytes}>{formatBytes(queueBytes)}</option>}
                {BUFFERS.map(b => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {!enabled && data.enabled && (
            <Checkbox
              label="Delete what is already stored"
              description="Removes the database file, so the recorded payloads are really gone."
              checked={purge}
              disabled={!editable || saving}
              onChange={e => setPurge(e.target.checked)}
            />
          )}
          {data.managed && (
            <p className="text-sm text-muted">
              This installation is configured with <code className="font-mono">HISTORY_DB</code>; change the environment of the server to switch it off.
            </p>
          )}
          {!canWrite && <p className="text-sm text-muted">A read-only account cannot change this.</p>}
          {data.db && (
            <>
              <KeyValueGrid
                items={[
                  { label: 'Messages', value: formatNumber(data.db.messages) },
                  { label: 'Size on disk', value: formatBytes(data.db.bytes) },
                  { label: 'Oldest message', value: data.db.oldest ? formatDateTime(data.db.oldest) : '–' },
                  { label: 'Waiting to be written', value: `${formatBytes(data.db.queued)} of ${formatBytes(data.db.queueBytes)}` },
                  ...(data.db.filtered > 0 ? [{ label: 'Left out by the filter', value: formatNumber(data.db.filtered) }] : []),
                  ...(data.db.dropped > 0 ? [{ label: 'Not persisted', value: `${formatNumber(data.db.dropped)} (the writer fell behind)` }] : []),
                ]}
              />
              {data.db.dropped > 0 && (
                <DroppedHint dropped={data.db.dropped} fullText={fullText} hasFilter={filter.trim() !== ''} buffered={data.db.queueBytes} />
              )}
            </>
          )}
          {data.path && (
            <p className="text-xs text-faint font-mono break-all flex items-start gap-1.5">
              <HardDrive size={12} className="mt-0.5 shrink-0" />
              {data.path}
            </p>
          )}
          {editable && (
            <div className="flex justify-end">
              <Button variant="primary" disabled={!changed} loading={saving} onClick={save}>
                Save
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * What to do about messages that did not reach the disk. The counter alone
 * only says something went wrong; the three settings above are the answer,
 * in the order of how much they buy.
 */
function DroppedHint({ dropped, fullText, hasFilter, buffered }: { dropped: number; fullText: boolean; hasFilter: boolean; buffered: number }) {
  const remedies = [
    !hasFilter && 'write only the subjects that are searched for, with the filter above -- what it leaves out costs nothing at all',
    fullText && 'switch the full-text index off: it costs about three quarters of the write rate',
    buffered < 256 << 20 && 'raise the write buffer, if the load comes in bursts rather than steadily',
  ].filter(Boolean) as string[];
  return (
    <div className="text-xs text-warn border border-warn/30 bg-warn/5 rounded p-2 flex flex-col gap-1">
      <span className="font-medium">
        {formatNumber(dropped)} {dropped === 1 ? 'message' : 'messages'} did not reach the disk.
      </span>
      <span className="text-muted">
        They arrived faster than SQLite could write them and the buffer was full. The live view and the subject tree are unaffected -- only the copy on disk has
        gaps.
      </span>
      {remedies.length > 0 && (
        <ul className="list-disc list-inside text-muted">
          {remedies.map(r => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Settings of this installation that live on the backend, not in the browser. */
export default function SettingsDialog() {
  const open = useStore(s => s.settingsOpen);
  const setOpen = useStore(s => s.setSettingsOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen} title="Settings" width="md">
      {open && <HistorySection />}
    </Dialog>
  );
}
