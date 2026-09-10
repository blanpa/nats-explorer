import { useMemo, useRef, useState } from 'react';
import { Download, Plus, Send, Upload } from 'lucide-react';
import { errorMessage } from '../../lib/api';
import { newSavedRequest, parseCollection, serializeCollection } from '../../lib/savedRequests';
import { useStore } from '../../store';
import { useSavedRequests } from '../../store/savedRequests';
import { cn } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { EmptyState, PaneHeader } from '../ui/misc';
import { toast } from '../ui/Toast';

export default function TemplateList() {
  const items = useSavedRequests(s => s.items);
  const upsert = useSavedRequests(s => s.upsert);
  const importMany = useSavedRequests(s => s.importMany);
  const selected = useStore(s => s.selectedTemplateId);
  const setSelected = useStore(s => s.setSelectedTemplateId);
  const [filter, setFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return [...items]
      .filter(t => !q || t.name.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name) || a.subject.localeCompare(b.subject));
  }, [items, filter]);

  const create = () => {
    const t = newSavedRequest({ name: 'Untitled request', subject: '' });
    upsert(t);
    setSelected(t.id);
  };

  const exportAll = () => {
    const blob = new Blob([serializeCollection(items)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nats-explorer-requests-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const n = importMany(parseCollection(await file.text()));
      if (n === 0) toast.error('Nothing imported', 'The file contains no request templates.');
    } catch (err) {
      toast.error('Import failed', errorMessage(err));
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        title="Requests"
        actions={
          <>
            <IconButton label="Import JSON" size="xs" onClick={() => fileRef.current?.click()}>
              <Upload size={13} />
            </IconButton>
            <IconButton label="Export all as JSON" size="xs" disabled={items.length === 0} onClick={exportAll}>
              <Download size={13} />
            </IconButton>
            <IconButton label="New request" size="xs" onClick={create}>
              <Plus size={14} />
            </IconButton>
          </>
        }
      />
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={e => importFile(e.target.files?.[0]).finally(() => (e.target.value = ''))}
      />
      <div className="px-2 py-2 border-b border-line">
        <SearchInput value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter requests…" />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {list.length === 0 ? (
          <EmptyState
            compact
            icon={Send}
            title={filter ? 'No matching requests' : 'No saved requests'}
            description={filter ? undefined : 'Create a request template or import a JSON collection. Templates are stored in this browser.'}
          />
        ) : (
          list.map(t => (
            <div
              key={t.id}
              className={cn('list-row flex-col items-stretch gap-0.5 py-1.5', selected === t.id && 'list-row-active')}
              onClick={() => setSelected(t.id)}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={cn('font-mono text-2xs w-7 shrink-0', t.mode === 'request' ? 'text-info' : 'text-accent')}>
                  {t.mode === 'request' ? 'REQ' : 'PUB'}
                </span>
                <span className="font-medium truncate">{t.name || <span className="text-faint italic">unnamed</span>}</span>
                {t.count && t.count > 1 && <span className="ml-auto text-xs text-faint font-mono shrink-0">{t.count}×</span>}
              </div>
              <div className="text-xs text-muted font-mono truncate pl-9">{t.subject || <span className="text-faint">no subject</span>}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
