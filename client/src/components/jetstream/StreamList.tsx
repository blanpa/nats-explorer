import { useMemo, useState } from 'react';
import { Eye, EyeOff, Layers, Plus, RefreshCw } from 'lucide-react';
import type { StreamInfo } from 'shared';
import { api, describeJsError } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useJsDomainOverride, useStore } from '../../store';
import { cn, formatBytes, formatNumber, readSetting, writeSetting } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';
import StreamDialog from './StreamDialog';
import DomainSwitch from './DomainSwitch';

const isInternal = (name: string) => name.startsWith('KV_') || name.startsWith('OBJ_');

export default function StreamList() {
  const connId = useStore(s => s.activeConnId);
  const domainOverride = useJsDomainOverride(connId);
  const connDomain = useStore(s => s.connections.find(c => c.id === connId)?.jsDomain);
  const domainLabel = domainOverride || connDomain || undefined;
  const selected = useStore(s => s.selectedStream);
  const setSelected = useStore(s => s.setSelectedStream);
  const tick = useStore(s => s.refreshTick);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  // KV buckets and object stores are backed by KV_*/OBJ_* streams that have their own modules.
  const [hideInternal, setHideInternalState] = useState(() => readSetting('ne.hideInternalStreams', true));
  const setHideInternal = (b: boolean) => {
    writeSetting('ne.hideInternalStreams', b);
    setHideInternalState(b);
  };

  const { data, error, loading, initial, reload } = useAsync<StreamInfo[]>(() => (connId ? api.listStreams(connId) : null), [connId, tick], { key: `streams:${connId}`, interval: 10_000 });

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
        children={<DomainSwitch />}
        actions={
          <>
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
            <IconButton label="Create stream" size="xs" onClick={() => setCreating(true)}>
              <Plus size={14} />
            </IconButton>
          </>
        }
      />
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
            description={filter ? undefined : hideInternal && internalCount > 0 ? `${internalCount} internal stream${internalCount === 1 ? '' : 's'} hidden. Use the eye icon to show them.` : 'Create a stream to start persisting messages.'}
          />
        ) : (
          streams.map(s => (
            <div key={s.name} className={cn('list-row flex-col items-stretch gap-0.5 py-2', selected === s.name && 'list-row-active')} onClick={() => setSelected(s.name)}>
              <div className="flex items-center gap-2 min-w-0">
                <Layers size={13} className="text-accent shrink-0" />
                <span className="font-medium truncate">{s.name}</span>
                <span className="ml-auto flex items-center gap-1 shrink-0">
                  {s.storage === 'Memory' && <Badge tone="info">mem</Badge>}
                  {s.retention !== 'Limits' && <Badge tone="warn">{s.retention.toLowerCase()}</Badge>}
                  {s.mirror && <Badge tone="neutral">mirror</Badge>}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted font-mono tabular-nums pl-5">
                <span>{formatNumber(s.state.messages)} msgs</span>
                <span>{formatBytes(s.state.bytes)}</span>
                <span>{s.state.consumerCount} {s.state.consumerCount === 1 ? 'consumer' : 'consumers'}</span>
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
