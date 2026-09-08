import { useMemo, useState } from 'react';
import { KeyRound, Plus, RefreshCw } from 'lucide-react';
import type { KvBucketInfo } from 'shared';
import { api, describeJsError, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useJsDomainOverride, useStore } from '../../store';
import { cn, formatBytes, formatDurationNs, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Field, Input, SearchInput, Select } from '../ui/Input';
import { Dialog } from '../ui/Dialog';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';
import DomainSwitch from '../jetstream/DomainSwitch';
import { useCanWrite } from '../../lib/auth';

export default function KvBucketList() {
  const canWrite = useCanWrite();
  const connId = useStore(s => s.activeConnId);
  const domainOverride = useJsDomainOverride(connId);
  const connDomain = useStore(s => s.connections.find(c => c.id === connId)?.jsDomain);
  const domainLabel = domainOverride || connDomain || undefined;
  const selected = useStore(s => s.selectedKvBucket);
  const setSelected = useStore(s => s.setSelectedKvBucket);
  const tick = useStore(s => s.refreshTick);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);

  const { data, error, loading, initial, reload } = useAsync<KvBucketInfo[]>(() => (connId ? api.listKvBuckets(connId) : null), [connId, tick], {
    key: `kv:${connId}`,
    interval: 10_000,
  });

  const buckets = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data ?? []).filter(b => !q || b.bucket.toLowerCase().includes(q));
  }, [data, filter]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        title="Key-Value buckets"
        actions={
          <>
            <IconButton label="Refresh" size="xs" loading={loading && !initial} onClick={reload}>
              <RefreshCw size={13} />
            </IconButton>
            {canWrite && (
              <IconButton label="Create bucket" size="xs" onClick={() => setCreating(true)}>
                <Plus size={14} />
              </IconButton>
            )}
          </>
        }
      >
        <DomainSwitch />
      </PaneHeader>
      <div className="px-2 py-2 border-b border-line">
        <SearchInput value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter buckets…" />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {initial && loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Cannot list buckets" message={describeJsError(error, domainLabel)} />
        ) : buckets.length === 0 ? (
          <EmptyState
            compact
            icon={KeyRound}
            title={filter ? 'No matching buckets' : 'No KV buckets'}
            description={filter ? undefined : 'Create a bucket to store keys with revision history.'}
          />
        ) : (
          buckets.map(b => (
            <div
              key={b.bucket}
              className={cn('list-row flex-col items-stretch gap-0.5 py-2', selected === b.bucket && 'list-row-active')}
              onClick={() => setSelected(b.bucket)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <KeyRound size={13} className="text-accent shrink-0" />
                <span className="font-medium truncate">{b.bucket}</span>
                <span className="ml-auto flex items-center gap-1">
                  {b.storage === 'Memory' && <Badge tone="info">mem</Badge>}
                  {b.ttl > 0 && <Badge tone="neutral">ttl {formatDurationNs(b.ttl)}</Badge>}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted font-mono tabular-nums pl-5">
                <span>{formatNumber(b.values)} entries</span>
                <span>{formatBytes(b.bytes)}</span>
                <span>history {b.history}</span>
              </div>
            </div>
          ))
        )}
      </div>
      {creating && connId && (
        <CreateBucketDialog
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

function CreateBucketDialog({ connId, onClose, onCreated }: { connId: string; onClose: () => void; onCreated: (name: string) => void }) {
  const [bucket, setBucket] = useState('');
  const [description, setDescription] = useState('');
  const [history, setHistory] = useState('1');
  const [ttl, setTtl] = useState('');
  const [storage, setStorage] = useState<'file' | 'memory'>('file');
  const [replicas, setReplicas] = useState('1');
  const [maxBytes, setMaxBytes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[A-Za-z0-9_-]+$/.test(bucket);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      await api.createKvBucket(connId, {
        bucket,
        description: description || undefined,
        history: Math.min(64, Math.max(1, Number(history) || 1)),
        ttl: Number(ttl) > 0 ? Number(ttl) * 1e9 : undefined,
        storage,
        replicas: Math.max(1, Number(replicas) || 1),
        maxBytes: Number(maxBytes) > 0 ? Number(maxBytes) : undefined,
      });
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
      title="Create KV bucket"
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger font-mono truncate">{error}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>
            Create bucket
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
        <Field label="Bucket name" hint="Letters, digits, dash and underscore." required>
          <Input mono value={bucket} onChange={e => setBucket(e.target.value)} placeholder="config" autoFocus />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={e => setDescription(e.target.value)} />
        </Field>
        <Field label="History per key" hint="1 – 64 revisions">
          <Input type="number" min={1} max={64} value={history} onChange={e => setHistory(e.target.value)} />
        </Field>
        <Field label="TTL (seconds)" hint="Empty = keys never expire">
          <Input type="number" min={0} value={ttl} onChange={e => setTtl(e.target.value)} placeholder="unlimited" />
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
      </form>
    </Dialog>
  );
}
