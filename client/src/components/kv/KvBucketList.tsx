import { useMemo, useState } from 'react';
import { KeyRound, Plus, RefreshCw } from 'lucide-react';
import type { KvBucketInfo } from 'shared';
import { api, describeJsError, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useJsDomainOverride, useStore } from '../../store';
import { cn, formatBytes, formatDurationNs, formatNumber } from '../../lib/utils';
import { Button, IconButton } from '../ui/Button';
import { Checkbox, Field, Input, SearchInput, Select, Textarea } from '../ui/Input';
import { formatMetadata, parseMetadata } from '../../lib/streamForm';
import { Dialog } from '../ui/Dialog';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';
import DomainSwitch from '../jetstream/DomainSwitch';
import { useCanWrite } from '../../lib/auth';
import { OpenBeside, useRowOpen } from '../ui/OpenBeside';

export default function KvBucketList() {
  const canWrite = useCanWrite();
  const connId = useStore(s => s.activeConnId);
  const domainOverride = useJsDomainOverride(connId);
  const connDomain = useStore(s => s.connections.find(c => c.id === connId)?.jsDomain);
  const domainLabel = domainOverride || connDomain || undefined;
  const selected = useStore(s => s.selectedKvBucket);
  const setSelected = useStore(s => s.setSelectedKvBucket);
  const rowOpen = useRowOpen('kv', setSelected);
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
              className={cn('list-row group flex-col items-stretch gap-0.5 py-2', selected === b.bucket && 'list-row-active')}
              onClick={e => rowOpen(e, b.bucket)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <KeyRound size={13} className="text-accent shrink-0" />
                <span className="font-medium truncate">{b.bucket}</span>
                <OpenBeside module="kv" name={b.bucket} />
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
        <BucketDialog
          connId={connId}
          onClose={() => setCreating(false)}
          onSaved={name => {
            setCreating(false);
            reload();
            setSelected(name);
          }}
        />
      )}
    </div>
  );
}

/**
 * Create a bucket, or with `existing` change what a bucket allows to
 * change: the limits, the TTL, the replicas, the sources and the metadata.
 * Name, storage and history are what it was made with.
 */
export function BucketDialog({
  connId,
  existing,
  onClose,
  onSaved,
}: {
  connId: string;
  existing?: KvBucketInfo;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const edit = !!existing;
  const [bucket, setBucket] = useState(existing?.bucket ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [history, setHistory] = useState(String(existing?.history ?? 1));
  const [ttl, setTtl] = useState(existing?.ttl ? String(existing.ttl / 1e9) : '');
  const [storage, setStorage] = useState<'file' | 'memory'>(existing?.storage?.toLowerCase() === 'memory' ? 'memory' : 'file');
  const [replicas, setReplicas] = useState(String(existing?.replicas ?? 1));
  const [maxBytes, setMaxBytes] = useState(existing && existing.maxBytes > 0 ? String(existing.maxBytes) : '');
  const [maxValueSize, setMaxValueSize] = useState(existing && existing.maxValueSize > 0 ? String(existing.maxValueSize) : '');
  const [compression, setCompression] = useState(existing?.compression ?? false);
  const [mirror, setMirror] = useState(existing?.mirror?.bucket ?? '');
  const [mirrorDomain, setMirrorDomain] = useState(existing?.mirror?.domain ?? '');
  const [sources, setSources] = useState(existing?.sources?.map(s => s.bucket).join(', ') ?? '');
  const [metadata, setMetadata] = useState(formatMetadata(existing?.metadata));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[A-Za-z0-9_-]+$/.test(bucket);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const common = {
      description,
      ttl: Number(ttl) > 0 ? Number(ttl) * 1e9 : 0,
      replicas: Math.max(1, Number(replicas) || 1),
      maxBytes: Number(maxBytes) > 0 ? Number(maxBytes) : -1,
      maxValueSize: Number(maxValueSize) > 0 ? Number(maxValueSize) : -1,
      compression,
      mirror: mirror.trim() ? { bucket: mirror.trim(), domain: mirrorDomain.trim() || undefined } : null,
      sources: sources
        .split(/[,\s]+/)
        .map(b => b.trim())
        .filter(Boolean)
        .map(b => ({ bucket: b })),
      metadata: parseMetadata(metadata),
    };
    try {
      if (edit) {
        await api.updateKvBucket(connId, bucket, common);
      } else {
        await api.createKvBucket(connId, {
          ...common,
          bucket,
          history: Math.min(64, Math.max(1, Number(history) || 1)),
          storage,
        });
      }
      onSaved(bucket);
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
      title={edit ? `Edit bucket ${existing!.bucket}` : 'Create KV bucket'}
      description={edit ? 'Name, storage and history are what the bucket was made with.' : undefined}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger font-mono truncate">{error}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={submit}>
            {edit ? 'Save changes' : 'Create bucket'}
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
          <Input mono value={bucket} onChange={e => setBucket(e.target.value)} placeholder="config" autoFocus={!edit} disabled={edit} />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={e => setDescription(e.target.value)} />
        </Field>
        <Field label="History per key" hint="1 – 64 revisions">
          <Input type="number" min={1} max={64} value={history} onChange={e => setHistory(e.target.value)} disabled={edit} />
        </Field>
        <Field label="TTL (seconds)" hint="Empty = keys never expire">
          <Input type="number" min={0} value={ttl} onChange={e => setTtl(e.target.value)} placeholder="unlimited" />
        </Field>
        <Field label="Storage">
          <Select value={storage} onChange={e => setStorage(e.target.value as 'file' | 'memory')} disabled={edit}>
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
        <Field label="Max value size (bytes)" hint="Empty = unlimited">
          <Input type="number" min={0} value={maxValueSize} onChange={e => setMaxValueSize(e.target.value)} placeholder="unlimited" />
        </Field>
        <Field label="Mirror of bucket" hint="A read-only copy of another bucket; set at creation.">
          <Input mono value={mirror} onChange={e => setMirror(e.target.value)} placeholder="config" disabled={edit} />
        </Field>
        <Field label="Mirror domain" hint="Where the origin lives, for a bucket in another JetStream domain.">
          <Input mono value={mirrorDomain} onChange={e => setMirrorDomain(e.target.value)} placeholder="hub" disabled={edit} />
        </Field>
        <Field label="Sources" hint="Buckets this one copies keys from, comma separated." className="md:col-span-2">
          <Input mono value={sources} onChange={e => setSources(e.target.value)} placeholder="config-eu, config-us" />
        </Field>
        <div className="md:col-span-2">
          <Checkbox
            label="Compress the backing stream"
            description="S2 on the file store; costs CPU, saves disk."
            checked={compression}
            onChange={e => setCompression(e.target.checked)}
          />
        </div>
        <Field label="Metadata" hint="One key=value per line." className="md:col-span-2">
          <Textarea rows={2} value={metadata} onChange={e => setMetadata(e.target.value)} placeholder={'owner=plant'} />
        </Field>
      </form>
    </Dialog>
  );
}
