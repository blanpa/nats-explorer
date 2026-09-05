import { useMemo, useState } from 'react';
import { Archive, Plus, RefreshCw } from 'lucide-react';
import type { ObjStoreInfo } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useStore } from '../../store';
import { cn, formatBytes, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Field, Input, SearchInput, Select } from '../ui/Input';
import { Dialog } from '../ui/Dialog';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';
import { toast } from '../ui/Toast';

export default function ObjStoreList() {
  const connId = useStore(s => s.activeConnId);
  const selected = useStore(s => s.selectedObjStore);
  const setSelected = useStore(s => s.setSelectedObjStore);
  const tick = useStore(s => s.refreshTick);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);

  const { data, error, loading, initial, reload } = useAsync<ObjStoreInfo[]>(() => (connId ? api.listObjectStores(connId) : null), [connId, tick], { interval: 10_000 });

  const stores = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data ?? []).filter(s => !q || s.bucket.toLowerCase().includes(q));
  }, [data, filter]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        title="Object stores"
        actions={
          <>
            <IconButton label="Refresh" size="xs" loading={loading && !initial} onClick={reload}>
              <RefreshCw size={13} />
            </IconButton>
            <IconButton label="Create store" size="xs" onClick={() => setCreating(true)}>
              <Plus size={14} />
            </IconButton>
          </>
        }
      />
      <div className="px-2 py-2 border-b border-line">
        <SearchInput value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter stores…" />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {initial && loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Cannot list object stores" message={error} />
        ) : stores.length === 0 ? (
          <EmptyState compact icon={Archive} title={filter ? 'No matching stores' : 'No object stores'} description={filter ? undefined : 'Create a store to upload files and blobs.'} />
        ) : (
          stores.map(s => (
            <div key={s.bucket} className={cn('list-row flex-col items-stretch gap-0.5 py-2', selected === s.bucket && 'list-row-active')} onClick={() => setSelected(s.bucket)}>
              <div className="flex items-center gap-2 min-w-0">
                <Archive size={13} className="text-accent shrink-0" />
                <span className="font-medium truncate">{s.bucket}</span>
                <span className="ml-auto flex items-center gap-1">
                  {s.storage === 'Memory' && <Badge tone="info">mem</Badge>}
                  {s.sealed && <Badge tone="warn">sealed</Badge>}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted font-mono tabular-nums pl-5">
                <span>{formatBytes(s.size)}</span>
                <span>{formatNumber(s.chunks)} chunks</span>
                <span>R{s.replicas}</span>
              </div>
            </div>
          ))
        )}
      </div>
      {creating && connId && (
        <CreateStoreDialog
          connId={connId}
          onClose={() => setCreating(false)}
          onCreated={name => {
            setCreating(false);
            reload();
            setSelected(name);
          }}
        />
      )}
    </div>
  );
}

function CreateStoreDialog({ connId, onClose, onCreated }: { connId: string; onClose: () => void; onCreated: (name: string) => void }) {
  const [bucket, setBucket] = useState('');
  const [description, setDescription] = useState('');
  const [storage, setStorage] = useState<'file' | 'memory'>('file');
  const [replicas, setReplicas] = useState('1');
  const [maxBytes, setMaxBytes] = useState('');
  const [ttl, setTtl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[A-Za-z0-9_-]+$/.test(bucket);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.createObjectStore(connId, {
        bucket,
        description: description || undefined,
        storage,
        replicas: Math.max(1, Number(replicas) || 1),
        maxBytes: Number(maxBytes) > 0 ? Number(maxBytes) : undefined,
        ttl: Number(ttl) > 0 ? Number(ttl) * 1e9 : undefined,
      });
      toast.success(`Object store ${bucket} created`);
      onCreated(bucket);
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
      title="Create object store"
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger font-mono truncate">{error}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>
            Create store
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Store name" hint="Letters, digits, dash and underscore." required>
          <Input mono value={bucket} onChange={e => setBucket(e.target.value)} placeholder="assets" autoFocus />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={e => setDescription(e.target.value)} />
        </Field>
        <Field label="Storage">
          <Select value={storage} onChange={e => setStorage(e.target.value as 'file' | 'memory')}>
            <option value="file">File</option>
            <option value="memory">Memory</option>
          </Select>
        </Field>
        <Field label="Replicas">
          <Input type="number" min={1} max={5} value={replicas} onChange={e => setReplicas(e.target.value)} />
        </Field>
        <Field label="Max bytes" hint="Empty = unlimited">
          <Input type="number" min={0} value={maxBytes} onChange={e => setMaxBytes(e.target.value)} placeholder="unlimited" />
        </Field>
        <Field label="TTL (seconds)" hint="Empty = objects never expire">
          <Input type="number" min={0} value={ttl} onChange={e => setTtl(e.target.value)} placeholder="unlimited" />
        </Field>
      </form>
    </Dialog>
  );
}
