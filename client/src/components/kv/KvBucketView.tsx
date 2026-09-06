import { useEffect, useMemo, useState } from 'react';
import { Eraser, KeyRound, Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import type { KvEntry } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useLiveWatch } from '../../lib/live';
import { useJsDomainOverride, useStore } from '../../store';
import { cn, formatBytes, formatDateTime, formatRelative, prettyJson, previewPayload } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Field, Input, SearchInput, Textarea } from '../ui/Input';
import { confirm, Dialog } from '../ui/Dialog';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader, SectionTitle } from '../ui/misc';
import { toast } from '../ui/Toast';
import PayloadViewer from '../subjects/PayloadViewer';

export default function KvBucketView() {
  const connId = useStore(s => s.activeConnId);
  const bucket = useStore(s => s.selectedKvBucket);
  const domainOverride = useJsDomainOverride(connId);
  const setBucket = useStore(s => s.setSelectedKvBucket);
  const bump = useStore(s => s.bumpRefresh);
  const [filter, setFilter] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [putOpen, setPutOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);

  const keys = useAsync<string[]>(() => (connId && bucket ? api.listKvKeys(connId, bucket) : null), [connId, bucket], { key: `kvkeys:${connId}:${bucket}` });
  const entry = useAsync<KvEntry>(() => (connId && bucket && selectedKey ? api.getKvEntry(connId, bucket, selectedKey) : null), [connId, bucket, selectedKey], { key: `kventry:${connId}:${bucket}:${selectedKey}` });

  useEffect(() => {
    setSelectedKey(null);
    setFilter('');
    setEditing(false);
  }, [bucket]);

  // Server-side KV watch: keeps the key list and the open entry current without polling.
  useLiveWatch(
    connId && bucket ? { type: 'kv-watch', connId, bucket, domain: domainOverride } : null,
    connId && bucket ? { type: 'kv-unwatch', connId, bucket } : null,
    'kv-update',
    e => {
      if (e.connId !== connId || e.bucket !== bucket) return;
      keys.setData(prev => {
        const list = prev ?? [];
        if (e.entry.operation === 'put') return list.includes(e.entry.key) ? list : [...list, e.entry.key];
        return list.filter(k => k !== e.entry.key);
      });
      if (e.entry.key === selectedKey && !editing) entry.reload();
    },
  );

  const filteredKeys = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = keys.data ?? [];
    return (q ? list.filter(k => k.toLowerCase().includes(q)) : list).slice().sort();
  }, [keys.data, filter]);

  if (!bucket) return <EmptyState icon={KeyRound} title="Select a bucket" description="Key-Value buckets are backed by JetStream streams. Pick one to browse and edit its keys." />;
  if (!connId) return null;

  const saveEdit = async () => {
    if (!selectedKey) return;
    setSaving(true);
    try {
      const res = await api.putKvEntry(connId, bucket, selectedKey, editValue);
      setEditing(false);
      entry.reload();
      keys.reload();
    } catch (err) {
      toast.error('Save failed', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteKey = async (key: string) => {
    if (!(await confirm({ title: `Delete key ${key}?`, message: 'A delete marker is written; the history stays readable until purged.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.deleteKvEntry(connId, bucket, key);
      if (selectedKey === key) setSelectedKey(null);
      keys.reload();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  const purgeKey = async (key: string) => {
    if (!(await confirm({ title: `Purge key ${key}?`, message: 'All revisions of this key are removed permanently.', confirmLabel: 'Purge', danger: true }))) return;
    try {
      await api.purgeKvKey(connId, bucket, key);
      if (selectedKey === key) setSelectedKey(null);
      keys.reload();
    } catch (err) {
      toast.error('Purge failed', errorMessage(err));
    }
  };

  const deleteBucket = async () => {
    if (!(await confirm({ title: `Delete bucket ${bucket}?`, message: 'The bucket and all keys are removed permanently.', confirmLabel: 'Delete bucket', danger: true }))) return;
    try {
      await api.deleteKvBucket(connId, bucket);
      setBucket(null);
      bump();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  const e = entry.data;

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        className="h-12"
        actions={
          <>
            <IconButton label="Refresh keys" loading={keys.loading && !keys.initial} onClick={() => { keys.reload(); entry.reload(); }}>
              <RefreshCw size={14} />
            </IconButton>
            <Button variant="primary" icon={<Plus size={13} />} onClick={() => setPutOpen(true)}>
              Put key
            </Button>
            <Button variant="danger" icon={<Trash2 size={13} />} onClick={deleteBucket}>
              Delete bucket
            </Button>
          </>
        }
      >
        <KeyRound size={16} className="text-accent shrink-0" />
        <div className="min-w-0">
          <div className="text-md font-semibold truncate">{bucket}</div>
          <div className="text-xs text-muted flex items-center gap-1.5">
            {keys.data ? `${keys.data.length.toLocaleString()} keys` : '…'}
            <span className="status-dot bg-ok animate-pulse-dot !w-1.5 !h-1.5" title="Live: changes are pushed from the server" />
            <span className="text-faint">live</span>
          </div>
        </div>
      </PaneHeader>

      <div className="flex-1 min-h-0 flex">
        <div className="w-80 shrink-0 border-r border-line flex flex-col min-h-0">
          <div className="px-2 py-2 border-b border-line">
            <SearchInput value={filter} onChange={ev => setFilter(ev.target.value)} placeholder="Filter keys…" />
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            {keys.initial && keys.loading ? (
              <LoadingState />
            ) : keys.error ? (
              <ErrorState title="Cannot list keys" message={keys.error} />
            ) : filteredKeys.length === 0 ? (
              <EmptyState compact title={filter ? 'No matching keys' : 'Bucket is empty'} />
            ) : (
              filteredKeys.map(k => (
                <div key={k} className={cn('list-row group py-1 font-mono', selectedKey === k && 'list-row-active')} onClick={() => setSelectedKey(k)}>
                  <span className="truncate flex-1">{k}</span>
                  <IconButton
                    label="Delete key"
                    size="xs"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={ev => {
                      ev.stopPropagation();
                      deleteKey(k);
                    }}
                  >
                    <Trash2 size={12} className="text-danger" />
                  </IconButton>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="flex-1 min-w-0 min-h-0 overflow-auto p-4">
          {!selectedKey ? (
            <EmptyState compact title="Select a key" description="The current value, its revision and the full history are shown here." />
          ) : entry.initial && entry.loading ? (
            <LoadingState />
          ) : entry.error ? (
            <ErrorState title={`Cannot load ${selectedKey}`} message={entry.error} />
          ) : e ? (
            <div className="flex flex-col gap-4 max-w-[1100px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-md font-semibold break-all">{e.key}</span>
                <Badge tone="neutral">rev {e.revision}</Badge>
                <Badge tone="neutral">{formatBytes(e.size)}</Badge>
                <span className="text-xs text-muted" title={formatDateTime(e.created)}>
                  updated {formatRelative(e.created)}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  {editing ? (
                    <>
                      <Button variant="ghost" icon={<X size={13} />} onClick={() => setEditing(false)}>
                        Cancel
                      </Button>
                      <Button variant="primary" icon={<Save size={13} />} loading={saving} onClick={saveEdit}>
                        Save
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="outline"
                        icon={<Pencil size={13} />}
                        disabled={e.payloadType === 'binary'}
                        onClick={() => {
                          setEditValue(e.payloadType === 'json' ? prettyJson(e.value) : e.value);
                          setEditing(true);
                        }}
                      >
                        Edit
                      </Button>
                      <Button variant="outline" icon={<Eraser size={13} />} onClick={() => purgeKey(e.key)}>
                        Purge
                      </Button>
                      <Button variant="danger" icon={<Trash2 size={13} />} onClick={() => deleteKey(e.key)}>
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {editing ? (
                <Textarea rows={14} value={editValue} onChange={ev => setEditValue(ev.target.value)} autoFocus />
              ) : (
                <PayloadViewer payload={e.value} type={e.payloadType} size={e.size} maxHeight={420} />
              )}

              {e.history && e.history.length > 0 && (
                <div>
                  <SectionTitle>History · {e.history.length} {e.history.length === 1 ? 'revision' : 'revisions'}</SectionTitle>
                  <div className="card overflow-hidden">
                    <table className="table">
                      <thead>
                        <tr>
                          <th className="num">Rev</th>
                          <th>Operation</th>
                          <th>Time</th>
                          <th>Value</th>
                          <th className="num">Size</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...e.history].reverse().map(h => {
                          const p = previewPayload(h.value, h.payloadType, 100);
                          return (
                            <tr key={h.revision} className={h.revision === e.revision ? 'bg-accent/5' : ''}>
                              <td className="num">{h.revision}</td>
                              <td>
                                <Badge tone={h.operation === 'put' ? 'ok' : h.operation === 'delete' ? 'warn' : 'danger'}>{h.operation}</Badge>
                              </td>
                              <td className="font-mono text-muted">{formatDateTime(h.created)}</td>
                              <td className="font-mono max-w-[480px] truncate text-muted">{h.operation === 'put' ? p.text : '–'}</td>
                              <td className="num text-muted">{formatBytes(h.size)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {putOpen && (
        <PutKeyDialog
          connId={connId}
          bucket={bucket}
          onClose={() => setPutOpen(false)}
          onSaved={key => {
            setPutOpen(false);
            keys.reload();
            setSelectedKey(key);
            if (selectedKey === key) entry.reload();
          }}
        />
      )}
    </div>
  );
}

function PutKeyDialog({ connId, bucket, onClose, onSaved }: { connId: string; bucket: string; onClose: () => void; onSaved: (key: string) => void }) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = key.trim().length > 0 && !/\s/.test(key);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.putKvEntry(connId, bucket, key.trim(), value);
      onSaved(key.trim());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={o => !o && onClose()}
      title={`Put key in ${bucket}`}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger font-mono truncate">{error}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>
            Put
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={ev => {
          ev.preventDefault();
          submit();
        }}
      >
        <Field label="Key" hint="Dots create a hierarchy, e.g. config.db.host" required>
          <Input mono value={key} onChange={ev => setKey(ev.target.value)} autoFocus />
        </Field>
        <Field label="Value">
          <Textarea rows={8} value={value} onChange={ev => setValue(ev.target.value)} placeholder='{"enabled": true}' />
        </Field>
      </form>
    </Dialog>
  );
}
