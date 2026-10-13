import { formatCount, formatTime } from '../../lib/utils';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { KvBucketInfo, KvEntry } from 'shared';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useLiveWatch } from '../../lib/live';
import { subjectMatches } from '../../lib/subjectMatch';
import { useAsync } from '../../lib/useAsync';
import { useJsDomainOverride, useStore } from '../../store';
import { Button, IconButton } from '../ui/Button';
import { confirm } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';
import { toast } from '../ui/Toast';
import { BucketDialog } from './KvBucketList';
import KvEntryPanel from './KvEntryPanel';
import KvKeyList from './KvKeyList';
import PutKeyDialog from './PutKeyDialog';
import { useCanWrite } from '../../lib/auth';
import { useSelectedKvBucket, useSelectedKvKey } from '../../lib/pane';

/** How many changes the panel keeps; a watch runs as long as the bucket is open. */
const MAX_CHANGES = 500;

/** One change the watch delivered, with when it arrived here. */
interface Change {
  entry: KvEntry;
  at: number;
}

/** A bucket: its keys on the left, the selected entry on the right, kept live by a server-side watch. */
export default function KvBucketView() {
  const canWrite = useCanWrite();
  const connId = useStore(s => s.activeConnId);
  const [bucket, setBucket] = useSelectedKvBucket();
  const domainOverride = useJsDomainOverride(connId);
  const bump = useStore(s => s.bumpRefresh);
  const [filter, setFilter] = useState('');
  // In the store, so a link can open a key and a bucket change forgets it;
  // in a pane beside the main one, the pane's own.
  const [selectedKey, setSelectedKey] = useSelectedKvKey();
  const [putOpen, setPutOpen] = useState(false);
  const [editingBucket, setEditingBucket] = useState<KvBucketInfo | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // The changes the watch delivered, newest first, and whether they are
  // what the right-hand pane shows.
  const [changes, setChanges] = useState<Change[]>([]);
  const [showChanges, setShowChanges] = useState(false);
  const [changePattern, setChangePattern] = useState('');
  const editing = useRef(false);

  const keys = useAsync<string[]>(() => (connId && bucket ? api.listKvKeys(connId, bucket) : null), [connId, bucket], { key: `kvkeys:${connId}:${bucket}` });
  const entry = useAsync<KvEntry>(() => (connId && bucket && selectedKey ? api.getKvEntry(connId, bucket, selectedKey) : null), [connId, bucket, selectedKey], {
    key: `kventry:${connId}:${bucket}:${selectedKey}`,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset belongs to a bucket change, which the body itself does not read
  useEffect(() => {
    setFilter('');
    setChecked(new Set());
    setChanges([]);
    setShowChanges(false);
  }, [bucket]);

  // Server-side KV watch: keeps the key list and the open entry current
  // without polling, and feeds the list of changes.
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
      if (e.entry.key === selectedKey && !editing.current) entry.reload();
      setChanges(prev => [{ entry: e.entry, at: Date.now() }, ...prev].slice(0, MAX_CHANGES));
    },
  );

  const filteredKeys = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = keys.data ?? [];
    return (q ? list.filter(k => k.toLowerCase().includes(q)) : list).slice().sort();
  }, [keys.data, filter]);

  const shownChanges = useMemo(() => {
    const p = changePattern.trim();
    return p ? changes.filter(c => subjectMatches(p, c.entry.key)) : changes;
  }, [changes, changePattern]);

  if (!bucket) return <EmptyState icon={KeyRound} title="Select a bucket" description="Browse and edit the keys of a bucket." />;
  if (!connId) return null;

  // The revision is the one the editor opened on: a write in between is a
  // conflict the server names, and the entry is read again rather than
  // overwritten.
  const saveEntry = async (value: string, revision: number) => {
    if (!selectedKey) return;
    try {
      await api.putKvEntry(connId, bucket, selectedKey, value, revision || undefined);
      entry.reload();
      keys.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.warning('Not saved: the key changed meanwhile', `${err.message}. The current value is shown; edit it again.`);
        entry.reload();
      } else {
        toast.error('Save failed', errorMessage(err));
      }
      throw err;
    }
  };

  const deleteKey = async (key: string) => {
    if (
      !(await confirm({
        title: `Delete key ${key}?`,
        message: 'A delete marker is written; the history stays readable until purged.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteKvEntry(connId, bucket, key);
      if (selectedKey === key) setSelectedKey(null);
      keys.reload();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  const purgeKey = async (key: string) => {
    if (!(await confirm({ title: `Purge key ${key}?`, message: 'All revisions of this key are removed permanently.', confirmLabel: 'Purge', danger: true })))
      return;
    try {
      await api.purgeKvKey(connId, bucket, key);
      if (selectedKey === key) setSelectedKey(null);
      keys.reload();
    } catch (err) {
      toast.error('Purge failed', errorMessage(err));
    }
  };

  // Many at once: what failed is named, the rest is gone.
  const deleteChecked = async (purge: boolean) => {
    const list = [...checked];
    if (list.length === 0) return;
    if (
      !(await confirm({
        title: `${purge ? 'Purge' : 'Delete'} ${formatCount(list.length)} keys?`,
        message: purge ? 'Every revision of each key is removed permanently.' : 'A delete marker is written for each; the history stays readable until purged.',
        confirmLabel: purge ? 'Purge' : 'Delete',
        danger: true,
      }))
    )
      return;
    try {
      const res = await api.deleteKvKeys(connId, bucket, list, purge);
      const failed = Object.entries(res.failed);
      if (failed.length)
        toast.warning(`${failed.length} of ${list.length} keys not ${purge ? 'purged' : 'deleted'}`, failed.map(([k, e]) => `${k}: ${e}`).join('\n'));
      if (selectedKey && checked.has(selectedKey)) setSelectedKey(null);
      setChecked(new Set());
      keys.reload();
    } catch (err) {
      toast.error(purge ? 'Purge failed' : 'Delete failed', errorMessage(err));
    }
  };

  const deleteBucket = async () => {
    if (
      !(await confirm({
        title: `Delete bucket ${bucket}?`,
        message: 'The bucket and all keys are removed permanently.',
        confirmLabel: 'Delete bucket',
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteKvBucket(connId, bucket);
      setBucket(null);
      bump();
    } catch (err) {
      toast.error('Delete failed', errorMessage(err));
    }
  };

  const editBucket = async () => {
    try {
      const info = (await api.listKvBuckets(connId)).find(b => b.bucket === bucket);
      if (!info) throw new Error('the bucket is not in the listing');
      setEditingBucket(info);
    } catch (err) {
      toast.error('Cannot edit the bucket', errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        className="h-12"
        actions={
          <>
            <IconButton
              label="Refresh keys"
              loading={keys.loading && !keys.initial}
              onClick={() => {
                keys.reload();
                entry.reload();
              }}
            >
              <RefreshCw size={14} />
            </IconButton>
            <Button
              variant="outline"
              active={showChanges}
              icon={<Activity size={13} className={changes.length ? 'text-ok' : undefined} />}
              onClick={() => setShowChanges(v => !v)}
              title="What the watch delivered while the bucket was open"
            >
              Changes{changes.length ? ` · ${formatCount(changes.length)}` : ''}
            </Button>
            {canWrite && (
              <>
                {checked.size > 0 && (
                  <>
                    <Button variant="danger" icon={<Trash2 size={13} />} onClick={() => deleteChecked(false)}>
                      Delete {formatCount(checked.size)}
                    </Button>
                    <Button variant="danger" onClick={() => deleteChecked(true)}>
                      Purge {formatCount(checked.size)}
                    </Button>
                  </>
                )}
                <Button variant="primary" icon={<Plus size={13} />} onClick={() => setPutOpen(true)}>
                  Put key
                </Button>
                <IconButton label="Edit bucket" onClick={editBucket}>
                  <Pencil size={14} />
                </IconButton>
                <Button variant="danger" icon={<Trash2 size={13} />} onClick={deleteBucket}>
                  Delete bucket
                </Button>
              </>
            )}
          </>
        }
      >
        <KeyRound size={16} className="text-accent shrink-0" />
        <div className="min-w-0">
          <div className="text-md font-semibold truncate">{bucket}</div>
          <div className="text-xs text-muted flex items-center gap-1.5">
            {keys.data ? `${formatCount(keys.data.length)} keys` : '…'}
            <span className="status-dot bg-ok animate-pulse-dot w-1.5! h-1.5!" title="Live: changes are pushed from the server" />
            <span className="text-faint">live</span>
          </div>
        </div>
      </PaneHeader>

      <div className="flex-1 min-h-0 flex">
        <KvKeyList
          keys={filteredKeys}
          loading={keys.initial && keys.loading}
          error={keys.error}
          filter={filter}
          onFilter={setFilter}
          selected={selectedKey}
          onSelect={key => {
            setSelectedKey(key);
            setShowChanges(false);
          }}
          onDelete={deleteKey}
          checked={checked}
          onCheck={(key, on) =>
            setChecked(prev => {
              const next = new Set(prev);
              if (on) next.add(key);
              else next.delete(key);
              return next;
            })
          }
          onCheckAll={on => setChecked(on ? new Set(filteredKeys) : new Set())}
        />

        <div className="flex-1 min-w-0 min-h-0 overflow-auto p-4">
          {showChanges ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Input
                  inputSize="sm"
                  mono
                  className="w-64"
                  placeholder="Key pattern, e.g. line1.>"
                  value={changePattern}
                  onChange={e => setChangePattern(e.target.value)}
                  aria-label="Key pattern"
                />
                <span className="text-xs text-muted">
                  {shownChanges.length} of {changes.length} changes since the bucket was opened
                </span>
                {changes.length > 0 && (
                  <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setChanges([])}>
                    Clear
                  </Button>
                )}
              </div>
              {shownChanges.length === 0 ? (
                <EmptyState compact title="No changes yet" description="Every put, delete and purge on the bucket lands here as it happens." />
              ) : (
                <div className="card divide-y divide-line/70">
                  {shownChanges.map(c => (
                    <button
                      type="button"
                      key={`${c.entry.key}-${c.entry.revision}-${c.at}`}
                      className="list-row w-full text-left py-1.5 gap-2 font-mono text-xs"
                      onClick={() => {
                        setSelectedKey(c.entry.key);
                        setShowChanges(false);
                      }}
                      title={`Open ${c.entry.key}`}
                    >
                      <span className="text-faint tabular-nums shrink-0">{formatTime(c.at)}</span>
                      <Badge tone={c.entry.operation === 'put' ? 'ok' : c.entry.operation === 'delete' ? 'warn' : 'danger'}>{c.entry.operation}</Badge>
                      <span className="truncate max-w-[280px]">{c.entry.key}</span>
                      <span className="text-faint shrink-0">rev {c.entry.revision}</span>
                      {c.entry.operation === 'put' && <span className="text-muted truncate flex-1">{c.entry.value}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : !selectedKey ? (
            <EmptyState compact title="Select a key" />
          ) : entry.initial && entry.loading ? (
            <LoadingState />
          ) : entry.error ? (
            <ErrorState title={`Cannot load ${selectedKey}`} message={entry.error} />
          ) : entry.data ? (
            <KvEntryPanel
              key={entry.data.key}
              entry={entry.data}
              onSave={saveEntry}
              onPurge={() => purgeKey(entry.data!.key)}
              onDelete={() => deleteKey(entry.data!.key)}
              onEditing={v => {
                editing.current = v;
              }}
            />
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
      {editingBucket && (
        <BucketDialog
          connId={connId}
          existing={editingBucket}
          onClose={() => setEditingBucket(null)}
          onSaved={() => {
            setEditingBucket(null);
            bump();
          }}
        />
      )}
    </div>
  );
}
