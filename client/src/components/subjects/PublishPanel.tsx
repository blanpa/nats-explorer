import { useEffect, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bookmark, BookmarkPlus, ChevronDown, History, SlidersHorizontal } from 'lucide-react';
import { useStore } from '../../store';
import { useSavedRequests } from '../../store/savedRequests';
import { draftFromSaved, emptyDraft, newSavedRequest, savedFromDraft, type RequestDraft, type RequestMode, type HeaderPair } from '../../lib/savedRequests';
import { cn, writeSetting } from '../../lib/utils';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { RequestForm, RequestResult, useRequestRunner, useSendConnection } from '../requests/RequestForm';

interface RecentSend {
  mode: RequestMode;
  subject: string;
  payload: string;
  headers: HeaderPair[];
  ts: number;
}

const RECENT_KEY = 'ne.publishRecent';
const RECENT_MAX = 12;

function loadRecent(): RecentSend[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentSend[]) : [];
  } catch {
    return [];
  }
}

function pushRecent(item: RecentSend): RecentSend[] {
  const list = [item, ...loadRecent().filter(r => !(r.subject === item.subject && r.payload === item.payload && r.mode === item.mode))].slice(0, RECENT_MAX);
  writeSetting(RECENT_KEY, list);
  return list;
}

const menuClass = 'z-50 rounded border border-line bg-panel shadow-pop p-1 animate-fade-in outline-none';
const itemClass = 'flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer outline-none text-sm data-[highlighted]:bg-field';

/** Quick publish/request drawer below the subject detail. Templates live in the Requests module. */
export default function PublishPanel() {
  const selectedSubject = useStore(s => s.selectedSubject);
  const prefill = useStore(s => s.publishPrefill);
  const clearPrefill = useStore(s => s.prefillPublish);
  const setModule = useStore(s => s.setModule);
  const setSelectedTemplate = useStore(s => s.setSelectedTemplateId);
  const saved = useSavedRequests(s => s.items);
  const upsertSaved = useSavedRequests(s => s.upsert);

  const [draft, setDraft] = useState<RequestDraft>(() => emptyDraft(selectedSubject ?? ''));
  const [connChoice, setConnChoice] = useState('');
  const [recent, setRecent] = useState<RecentSend[]>(loadRecent);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const runner = useRequestRunner();
  const { effective } = useSendConnection(connChoice);

  useEffect(() => {
    if (prefill) {
      setDraft(d => ({ ...d, subject: prefill.subject, payload: prefill.payload ?? d.payload }));
      clearPrefill(null);
    }
  }, [prefill, clearPrefill]);

  const activeTemplate = templateId ? saved.find(s => s.id === templateId) ?? null : null;

  const send = () => {
    if (!effective) return;
    setRecent(pushRecent({ mode: draft.mode, subject: draft.subject.trim(), payload: draft.payload, headers: draft.headers.filter(h => h.key.trim()), ts: Date.now() }));
    runner.send(draft, effective);
  };

  const saveNew = () => {
    const item = newSavedRequest(savedFromDraft(draft, { id: '', name: name.trim() || draft.subject.trim() || 'Untitled request' }));
    upsertSaved(item);
    setTemplateId(item.id);
    setNaming(false);
    setName('');
  };

  const toolbarExtra = (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="ghost" icon={<Bookmark size={13} />} className={cn(activeTemplate && 'text-fg')}>
            <span className="max-w-[160px] truncate">{activeTemplate ? activeTemplate.name : 'Templates'}</span>
            <ChevronDown size={12} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className={cn(menuClass, 'w-[380px] max-w-[calc(100vw-32px)]')}>
            {saved.length === 0 && <div className="px-2 py-2 text-xs text-muted">No saved templates yet.</div>}
            <div className="max-h-[300px] overflow-auto">
              {[...saved]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(t => (
                  <DropdownMenu.Item
                    key={t.id}
                    onSelect={() => {
                      setDraft(draftFromSaved(t));
                      setTemplateId(t.id);
                      runner.clear();
                    }}
                    className={cn(itemClass, t.id === templateId && 'bg-accent/10')}
                  >
                    <span className={cn('font-mono text-xs w-8 shrink-0', t.mode === 'request' ? 'text-info' : 'text-accent')}>{t.mode === 'request' ? 'REQ' : 'PUB'}</span>
                    <span className="flex flex-col min-w-0 flex-1">
                      <span className="truncate">{t.name}</span>
                      <span className="font-mono text-xs text-muted truncate">
                        {t.subject}
                        {t.count && t.count > 1 ? ` · ${t.count}×` : ''}
                      </span>
                    </span>
                  </DropdownMenu.Item>
                ))}
            </div>
            <DropdownMenu.Separator className="h-px bg-line my-1" />
            {activeTemplate && (
              <DropdownMenu.Item onSelect={() => upsertSaved(savedFromDraft(draft, activeTemplate))} className={itemClass}>
                <Bookmark size={13} /> Save changes to “{activeTemplate.name}”
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item
              onSelect={() => {
                setName(activeTemplate?.name ?? '');
                setNaming(true);
              }}
              className={itemClass}
            >
              <BookmarkPlus size={13} /> Save as template…
            </DropdownMenu.Item>
            <DropdownMenu.Item
              onSelect={() => {
                if (activeTemplate) setSelectedTemplate(activeTemplate.id);
                setModule('requests');
              }}
              className={itemClass}
            >
              <SlidersHorizontal size={13} /> Open Requests module
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {recent.length > 0 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button size="sm" variant="ghost" icon={<History size={13} />}>
              Recent <ChevronDown size={12} />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} className={cn(menuClass, 'w-[420px] max-w-[calc(100vw-32px)]')}>
              {recent.map((r, i) => (
                <DropdownMenu.Item
                  key={i}
                  onSelect={() => {
                    setDraft(d => ({ ...d, mode: r.mode, subject: r.subject, payload: r.payload, headers: r.headers }));
                    setTemplateId(null);
                  }}
                  className="flex flex-col gap-0.5 px-2 py-1.5 rounded cursor-pointer outline-none data-[highlighted]:bg-field"
                >
                  <span className="flex items-center gap-2 text-sm font-mono truncate">
                    <span className={r.mode === 'request' ? 'text-info' : 'text-accent'}>{r.mode === 'request' ? 'REQ' : 'PUB'}</span>
                    <span className="truncate">{r.subject}</span>
                  </span>
                  <span className="text-xs text-muted font-mono truncate">{r.payload.replace(/\s+/g, ' ').slice(0, 90) || '(empty payload)'}</span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-3 p-3">
      <RequestForm
        draft={draft}
        onChange={setDraft}
        onSend={send}
        busy={runner.busy}
        canSend={!!effective}
        connId={effective ?? ''}
        onConnChange={setConnChoice}
        toolbarExtra={toolbarExtra}
        subjectPlaceholder={selectedSubject ?? undefined}
      />
      {naming && (
        <form
          className="flex items-center gap-2"
          onSubmit={e => {
            e.preventDefault();
            saveNew();
          }}
        >
          <span className="text-xs text-muted">Template name</span>
          <Input inputSize="sm" className="w-64" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={draft.subject.trim() || 'e.g. Inventory lookup'} aria-label="Template name" />
          <Button size="sm" variant="primary" type="submit">
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </form>
      )}
      <RequestResult error={runner.error} run={runner.run} reply={runner.reply} />
    </div>
  );
}
