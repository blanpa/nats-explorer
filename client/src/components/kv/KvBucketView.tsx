import { formatCount } from '../../lib/utils';
import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { KvEntry } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useLiveWatch } from '../../lib/live';
import { useAsync } from '../../lib/useAsync';
import { useJsDomainOverride, useStore } from '../../store';
import { Button, IconButton } from '../ui/Button';
import { confirm } from '../ui/Dialog';
import { EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';
import { toast } from '../ui/Toast';
import KvEntryPanel from './KvEntryPanel';
import KvKeyList from './KvKeyList';
import PutKeyDialog from './PutKeyDialog';
import { useCanWrite } from '../../lib/auth';

/** A bucket: its keys on the left, the selected entry on the right, kept live by a server-side watch. */
export default function KvBucketView() {
  const canWrite = useCanWrite();
  const connId = useStore(s => s.activeConnId);
  const bucket = useStore(s => s.selectedKvBucket);
  const domainOverride = useJsDomainOverride(connId);
  const setBucket = useStore(s => s.setSelectedKvBucket);
  const bump = useStore(s => s.bumpRefresh);
  const [filter, setFilter] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [putOpen, setPutOpen] = useState(false);
  const editing = useRef(false);

  const keys = useAsync<string[]>(() => (connId && bucket ? api.listKvKeys(connId, bucket) : null), [connId, bucket], { key: `kvkeys:${connId}:${bucket}` });
  const entry = useAsync<KvEntry>(() => (connId && bucket && selectedKey ? api.getKvEntry(connId, bucket, selectedKey) : null), [connId, bucket, selectedKey], {
    key: `kventry:${connId}:${bucket}:${selectedKey}`,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset belongs to a bucket change, which the body itself does not read
  useEffect(() => {
    setSelectedKey(null);
    setFilter('');
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
      if (e.entry.key === selectedKey && !editing.current) entry.reload();
    },
  );

  const filteredKeys = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = keys.data ?? [];
    return (q ? list.filter(k => k.toLowerCase().includes(q)) : list).slice().sort();
  }, [keys.data, filter]);

  if (!bucket) return <EmptyState icon={KeyRound} title="Select a bucket" description="Browse and edit the keys of a bucket." />;
  if (!connId) return null;

  const saveEntry = async (value: string) => {
    if (!selectedKey) return;
    try {
      await api.putKvEntry(connId, bucket, selectedKey, value);
      entry.reload();
      keys.reload();
    } catch (err) {
      toast.error('Save failed', errorMessage(err));
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
            {canWrite && (
              <>
                <Button variant="primary" icon={<Plus size={13} />} onClick={() => setPutOpen(true)}>
                  Put key
                </Button>
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
          onSelect={setSelectedKey}
          onDelete={deleteKey}
        />

        <div className="flex-1 min-w-0 min-h-0 overflow-auto p-4">
          {!selectedKey ? (
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
    </div>
  );
}
