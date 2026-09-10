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
import { Checkbox, Field, Select } from '../ui/Input';
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

/** The option matching a duration from the backend, or the raw value when it is not one of ours. */
function retentionValue(d: string): string {
  const hours = parseGoDuration(d) / 3600;
  return RETENTIONS.find(r => Number.parseFloat(r.value) === hours)?.value ?? d;
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
  const [edit, setEdit] = useState<{ enabled: boolean; retention: string; fullText: boolean } | null>(null);
  const [purge, setPurge] = useState(false);
  const [saving, setSaving] = useState(false);

  if (initial && loading) return <LoadingState label="Reading the history setting…" />;
  if (!data) return <ErrorState message={error ?? 'The history setting could not be read.'} />;

  const enabled = edit ? edit.enabled : data.enabled;
  const retention = edit ? edit.retention : retentionValue(data.retention);
  const fullText = edit ? edit.fullText : data.fullText !== false;
  const set = (patch: { enabled?: boolean; retention?: string; fullText?: boolean }) => setEdit({ enabled, retention, fullText, ...patch });

  const editable = data.supported && !data.managed && canWrite;
  const changed =
    enabled !== data.enabled || (enabled && (retention !== retentionValue(data.retention) || fullText !== (data.fullText !== false))) || (!enabled && purge);

  const save = async () => {
    setSaving(true);
    try {
      const next = await api.setHistoryPersistence({ enabled, retention, fullText, purge: !enabled && purge });
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
            <KeyValueGrid
              items={[
                { label: 'Messages', value: formatNumber(data.db.messages) },
                { label: 'Size on disk', value: formatBytes(data.db.bytes) },
                { label: 'Oldest message', value: data.db.oldest ? formatDateTime(data.db.oldest) : '–' },
                ...(data.db.dropped > 0 ? [{ label: 'Not persisted', value: `${formatNumber(data.db.dropped)} (the writer fell behind)` }] : []),
              ]}
            />
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
