import { useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Layers, Plus, RefreshCw, Upload, Waypoints } from 'lucide-react';
import type { StreamInfo } from 'shared';
import { api, describeJsError, errorMessage } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useJsDomainOverride, useStore } from '../../store';
import { cn, formatBytes, formatNumber } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';
import { toast } from '../ui/Toast';
import StreamDialog from './StreamDialog';
import DomainSwitch from './DomainSwitch';
import { useCanWrite } from '../../lib/auth';
import { OpenBeside, useRowOpen } from '../ui/OpenBeside';

const isInternal = (name: string) => name.startsWith('KV_') || name.startsWith('OBJ_');

export default function StreamList() {
  const canWrite = useCanWrite();
  const connId = useStore(s => s.activeConnId);
  const domainOverride = useJsDomainOverride(connId);
  const connDomain = useStore(s => s.connections.find(c => c.id === connId)?.jsDomain);
  const domainLabel = domainOverride || connDomain || undefined;
  const selected = useStore(s => s.selectedStream);
  const setSelected = useStore(s => s.setSelectedStream);
  const rowOpen = useRowOpen('jetstream', setSelected);
  const tick = useStore(s => s.refreshTick);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // KV buckets and object stores are backed by KV_*/OBJ_* streams that have their own modules.
  const hideInternal = useStore(s => s.hideInternalStreams);
  const setHideInternal = useStore(s => s.setHideInternalStreams);

  const { data, error, loading, initial, reload } = useAsync<StreamInfo[]>(() => (connId ? api.listStreams(connId) : null), [connId, tick], {
    key: `streams:${connId}`,
    interval: 10_000,
  });

  // A backup zip, as this explorer or the nats CLI wrote it: the stream it
  // names comes back with every message, and must not exist yet.
  const restore = async (file: File | undefined) => {
    if (!file || !connId) return;
    setRestoring(true);
    try {
      const info = await api.restoreStream(connId, file);
      reload();
      setSelected(info.name);
    } catch (err) {
      toast.error('Restore failed', errorMessage(err));
    } finally {
      setRestoring(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const internalCount = useMemo(() => (data ?? []).filter(s => isInternal(s.name)).length, [data]);
  const streams = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = data ?? [];
    // An explicit KV_/OBJ_ filter overrides the hiding.
    if (hideInternal && !/^(kv_|obj_|\$kv|\$o)/.test(q)) list = list.filter(s => !isInternal(s.name));
    return q ? list.filter(s => s.name.toLowerCase().includes(q) || s.subjects.some(sub => sub.toLowerCase().includes(q))) : list;
  }, [data, filter, hideInternal]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        title="Streams"
        actions={
          <>
            <IconButton
              label="How the streams hang together"
              size="xs"
              onClick={() => setSelected(null)}
              className={cn(!selected && 'text-accent')}
              aria-pressed={!selected}
            >
              <Waypoints size={13} />
            </IconButton>
            <IconButton
              label={hideInternal ? `Show KV/Object streams${internalCount ? ` (${internalCount} hidden)` : ''}` : 'Hide KV/Object streams'}
              size="xs"
              onClick={() => setHideInternal(!hideInternal)}
              className={cn(!hideInternal && 'text-accent')}
            >
              {hideInternal ? <EyeOff size={13} /> : <Eye size={13} />}
            </IconButton>
            <IconButton label="Refresh" size="xs" loading={loading && !initial} onClick={reload}>
              <RefreshCw size={13} />
            </IconButton>
            {canWrite && (
              <>
                <IconButton label="Restore a stream from a backup" size="xs" loading={restoring} onClick={() => fileInput.current?.click()}>
                  <Upload size={13} />
                </IconButton>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  aria-label="Backup file"
                  onChange={e => restore(e.target.files?.[0])}
                />
                <IconButton label="Create stream" size="xs" onClick={() => setCreating(true)}>
                  <Plus size={14} />
                </IconButton>
              </>
            )}
          </>
        }
      >
        <DomainSwitch />
      </PaneHeader>
      <div className="px-2 py-2 border-b border-line">
        <SearchInput value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter streams…" />
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {initial && loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Cannot list streams" message={describeJsError(error, domainLabel)} />
        ) : streams.length === 0 ? (
          <EmptyState
            compact
            icon={Layers}
            title={filter ? 'No matching streams' : hideInternal && internalCount > 0 ? 'Only KV/Object streams' : 'No streams'}
            description={
              filter
                ? undefined
                : hideInternal && internalCount > 0
                  ? `${internalCount} internal stream${internalCount === 1 ? '' : 's'} hidden. Use the eye icon to show them.`
                  : 'Create a stream to start persisting messages.'
            }
          />
        ) : (
          streams.map(s => (
            <div
              key={s.name}
              className={cn('list-row group flex-col items-stretch gap-0.5 py-2', selected === s.name && 'list-row-active')}
              onClick={e => rowOpen(e, s.name)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Layers size={13} className="text-accent shrink-0" />
                <span className="font-medium truncate">{s.name}</span>
                <OpenBeside module="jetstream" name={s.name} />
                <span className="ml-auto flex items-center gap-1 shrink-0">
                  {s.storage === 'Memory' && <Badge tone="info">mem</Badge>}
                  {s.retention !== 'Limits' && <Badge tone="warn">{s.retention.toLowerCase()}</Badge>}
                  {s.mirror && <Badge tone="neutral">mirror</Badge>}
                  {!s.mirror && s.sources?.length ? <Badge tone="neutral">sourced</Badge> : null}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted font-mono tabular-nums pl-5">
                <span>{formatNumber(s.state.messages)} msgs</span>
                <span>{formatBytes(s.state.bytes)}</span>
                <span>
                  {s.state.consumerCount} {s.state.consumerCount === 1 ? 'consumer' : 'consumers'}
                </span>
              </div>
              <div className="text-xs text-faint font-mono truncate pl-5">{s.subjects.join(', ')}</div>
            </div>
          ))
        )}
      </div>

      {creating && connId && (
        <StreamDialog
          connId={connId}
          onClose={() => setCreating(false)}
          onSaved={info => {
            setCreating(false);
            reload();
            setSelected(info.name);
          }}
        />
      )}
    </div>
  );
}
