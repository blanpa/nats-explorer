import { useEffect, useMemo, useState } from 'react';
import { Radio, RefreshCw } from 'lucide-react';
import { useStore } from '../../store';
import { useServices } from '../../store/services';
import { cn, formatRelative } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { Badge, EmptyState, ErrorState, LoadingState, PaneHeader } from '../ui/misc';

export default function ServiceList() {
  const connId = useStore(s => s.activeConnId);
  const selected = useStore(s => s.selectedService);
  const setSelected = useStore(s => s.setSelectedService);
  const { services, stats, loading, error, loadedAt, refresh } = useServices();
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!connId) return;
    refresh(connId);
    const t = setInterval(() => {
      if (!document.hidden) refresh(connId);
    }, 15_000);
    return () => clearInterval(t);
  }, [connId, refresh]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byName = new Map<string, typeof services>();
    for (const s of services) {
      if (q && !s.name.toLowerCase().includes(q) && !s.id.toLowerCase().includes(q)) continue;
      (byName.get(s.name) ?? byName.set(s.name, []).get(s.name)!).push(s);
    }
    return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [services, filter]);

  const errorsOf = (id: string) => stats.find(s => s.id === id)?.endpoints?.reduce((n, e) => n + (e.num_errors || 0), 0) ?? 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        title="Services"
        actions={
          <IconButton label="Rediscover" size="xs" loading={loading} onClick={() => connId && refresh(connId)}>
            <RefreshCw size={13} />
          </IconButton>
        }
      />
      <div className="px-2 py-2 border-b border-line">
        <SearchInput value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter services…" />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {loading && !loadedAt ? (
          <LoadingState label="Discovering services…" />
        ) : error ? (
          <ErrorState title="Discovery failed" message={error} />
        ) : groups.length === 0 ? (
          <EmptyState
            compact
            icon={Radio}
            title={filter ? 'No matching services' : 'No services found'}
            description={filter ? undefined : 'Only services built with the NATS micro framework answer $SRV.INFO requests.'}
          />
        ) : (
          groups.map(([name, instances]) => (
            <div key={name} className="py-1">
              <div className="px-3 py-1 text-xs font-semibold text-faint flex items-center gap-2">
                {name}
                <span className="font-mono normal-case tracking-normal">×{instances.length}</span>
              </div>
              {instances.map(s => {
                const errs = errorsOf(s.id);
                return (
                  <div key={s.id} className={cn('list-row py-1.5', selected === s.id && 'list-row-active')} onClick={() => setSelected(s.id)}>
                    <Radio size={13} className="text-accent shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs">{s.id}</span>
                      <span className="block text-xs text-muted">
                        v{s.version} · {s.endpoints?.length ?? 0} endpoints
                      </span>
                    </span>
                    {errs > 0 && <Badge tone="danger">{errs} err</Badge>}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      {loadedAt && <div className="px-3 h-7 flex items-center text-xs text-faint border-t border-line">discovered {formatRelative(loadedAt)}</div>}
    </div>
  );
}
