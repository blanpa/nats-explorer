import { useMemo, useState } from 'react';
import { Layers, Plus, RefreshCw } from 'lucide-react';
import type { StreamInfo } from 'shared';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { useStore } from '../../store';
import { cn, formatBytes, formatNumber } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';
import StreamDialog from './StreamDialog';

export default function StreamList() {
  const connId = useStore(s => s.activeConnId);
  const selected = useStore(s => s.selectedStream);
  const setSelected = useStore(s => s.setSelectedStream);
  const tick = useStore(s => s.refreshTick);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);

  const { data, error, loading, initial, reload } = useAsync<StreamInfo[]>(() => (connId ? api.listStreams(connId) : null), [connId, tick], { interval: 10_000 });

  const streams = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = data ?? [];
    return q ? list.filter(s => s.name.toLowerCase().includes(q) || s.subjects.some(sub => sub.toLowerCase().includes(q))) : list;
  }, [data, filter]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        title="Streams"
        actions={
          <>
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
          <ErrorState title="Cannot list streams" message={error} />
        ) : streams.length === 0 ? (
          <EmptyState compact icon={Layers} title={filter ? 'No matching streams' : 'No streams'} description={filter ? undefined : 'Create a stream to start persisting messages.'} />
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
                <span>{s.state.consumerCount} cons</span>
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
