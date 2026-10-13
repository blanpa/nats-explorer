import { useEffect, useMemo, useRef, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Archive, ArrowRight, FileIcon, Hash, KeyRound, Layers, Link2, Loader2, Moon, Plug, Search, Settings, Sun, Unplug } from 'lucide-react';
import { MODULES, useStore, type Module } from '../../store';
import { useSavedConnections } from '../../store/savedConnections';
import { currentLink, openLink } from '../../lib/urlSync';
import { api, type SearchHit } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Kbd } from '../ui/misc';
import { toast } from '../ui/Toast';

/** One thing the palette can do. */
interface Command {
  id: string;
  label: string;
  /** a second line under the label: what it is, where it goes */
  hint?: string;
  group: 'Go to' | 'Found' | 'Connections' | 'Actions';
  icon?: React.ReactNode;
  run: () => void;
}

/** Words typed, in order, each somewhere in the text. */
function matches(query: string, text: string): boolean {
  const t = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(w => t.includes(w));
}

const hitIcon: Record<SearchHit['kind'], React.ReactNode> = {
  subject: <Hash size={13} />,
  stream: <Layers size={13} />,
  bucket: <KeyRound size={13} />,
  key: <KeyRound size={13} />,
  store: <Archive size={13} />,
  object: <FileIcon size={13} />,
};

/** What a hit is called in the list, and what it says beside it. */
function describeHit(h: SearchHit): { label: string; hint: string } {
  switch (h.kind) {
    case 'subject':
      return { label: h.name, hint: 'subject' };
    case 'stream':
      return { label: h.name, hint: h.detail ? `stream · ${h.detail}` : 'stream' };
    case 'bucket':
      return { label: h.name, hint: 'Key-Value bucket' };
    case 'key':
      return { label: h.item ?? '', hint: `key in ${h.name}` };
    case 'store':
      return { label: h.name, hint: 'object store' };
    case 'object':
      return { label: h.item ?? '', hint: `object in ${h.name}` };
  }
}

/** How long the typing has to pause before the connection is searched. */
const SEARCH_DELAY_MS = 200;

/**
 * Everything a click away, from the keyboard: the modules, the saved and
 * open connections, the theme, the settings, a link to this view -- and,
 * once two letters are typed, the subjects, streams, buckets, keys, stores
 * and objects of the active connection by name. Ctrl-K opens it, typing
 * narrows it, Enter runs the first match.
 */
export default function CommandPalette() {
  const open = useStore(s => s.paletteOpen);
  const setOpen = useStore(s => s.setPaletteOpen);
  const setModule = useStore(s => s.setModule);
  const module = useStore(s => s.module);
  const connections = useStore(s => s.connections);
  const activeConnId = useStore(s => s.activeConnId);
  const setActiveConnId = useStore(s => s.setActiveConnId);
  const openConnectionsDialog = useStore(s => s.openConnectionsDialog);
  const setSettingsOpen = useStore(s => s.setSettingsOpen);
  const theme = useStore(s => s.theme);
  const toggleTheme = useStore(s => s.toggleTheme);
  const saved = useSavedConnections(s => s.items);
  const connect = useSavedConnections(s => s.connect);
  const disconnect = useSavedConnections(s => s.disconnect);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [found, setFound] = useState<{ q: string; hits: SearchHit[]; partial: boolean } | null>(null);
  const [searching, setSearching] = useState(false);

  // The connection is searched after a pause in the typing; an answer to an
  // older query is dropped.
  useEffect(() => {
    const q = query.trim();
    if (!open || !activeConnId || q.length < 2) {
      setFound(null);
      setSearching(false);
      return;
    }
    let stale = false;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .search(activeConnId, q)
        .then(res => {
          if (!stale) setFound({ q, hits: res.hits, partial: res.partial });
        })
        .catch(() => {
          if (!stale) setFound({ q, hits: [], partial: false });
        })
        .finally(() => {
          if (!stale) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, open, activeConnId]);

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    for (const m of MODULES) {
      out.push({
        id: `module:${m.id}`,
        label: m.label,
        hint: m.id === module ? 'the module open now' : undefined,
        group: 'Go to',
        icon: <ArrowRight size={13} />,
        run: () => setModule(m.id as Module),
      });
    }
    const live = new Map(connections.map(c => [c.id, c]));
    for (const c of saved) {
      const l = live.get(c.id);
      if (l?.connected) {
        if (c.id !== activeConnId) {
          out.push({
            id: `switch:${c.id}`,
            label: `Switch to ${c.name || c.servers[0]}`,
            hint: c.servers.join(', '),
            group: 'Connections',
            icon: <Plug size={13} />,
            run: () => setActiveConnId(c.id),
          });
        }
        out.push({
          id: `disconnect:${c.id}`,
          label: `Disconnect ${c.name || c.servers[0]}`,
          hint: c.servers.join(', '),
          group: 'Connections',
          icon: <Unplug size={13} />,
          run: () => void disconnect(c.id),
        });
      } else {
        out.push({
          id: `connect:${c.id}`,
          label: `Connect ${c.name || c.servers[0]}`,
          hint: c.servers.join(', '),
          group: 'Connections',
          icon: <Plug size={13} />,
          run: () => void connect(c.id),
        });
      }
    }
    out.push({ id: 'connections', label: 'Manage connections', group: 'Connections', icon: <Settings size={13} />, run: () => openConnectionsDialog() });
    out.push({
      id: 'theme',
      label: theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
      group: 'Actions',
      icon: theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />,
      run: toggleTheme,
    });
    out.push({
      id: 'settings',
      label: 'Settings',
      hint: 'history on disk, updates',
      group: 'Actions',
      icon: <Settings size={13} />,
      run: () => setSettingsOpen(true),
    });
    out.push({
      id: 'link',
      label: 'Copy a link to this view',
      hint: 'the module, the connection and what is selected',
      group: 'Actions',
      icon: <Link2 size={13} />,
      run: () => {
        navigator.clipboard?.writeText(currentLink()).then(() => toast.info('Link copied', currentLink()));
      },
    });
    return out;
  }, [module, connections, saved, activeConnId, theme, setModule, setActiveConnId, openConnectionsDialog, setSettingsOpen, toggleTheme, connect, disconnect]);

  const hitCommands = useMemo<Command[]>(() => {
    if (!found || !activeConnId) return [];
    return found.hits.map(h => {
      const { label, hint } = describeHit(h);
      return {
        id: `hit:${h.kind}:${h.name}:${h.item ?? ''}`,
        label,
        hint,
        group: 'Found' as const,
        icon: hitIcon[h.kind],
        run: () => {
          const conn = activeConnId;
          switch (h.kind) {
            case 'subject':
              return openLink({ module: 'subjects', conn, subject: h.name });
            case 'stream':
              return openLink({ module: 'jetstream', conn, stream: h.name });
            case 'bucket':
              return openLink({ module: 'kv', conn, bucket: h.name });
            case 'key':
              return openLink({ module: 'kv', conn, bucket: h.name, key: h.item });
            case 'store':
            case 'object':
              return openLink({ module: 'objects', conn, store: h.name });
          }
        },
      };
    });
  }, [found, activeConnId]);

  const shown = useMemo(() => {
    const own = commands.filter(c => matches(query, `${c.group} ${c.label} ${c.hint ?? ''}`));
    // The modules first, then what the connection holds, then the rest.
    return [...own.filter(c => c.group === 'Go to'), ...hitCommands, ...own.filter(c => c.group !== 'Go to')];
  }, [commands, hitCommands, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the cursor starts over with every query and every opening
  useEffect(() => setCursor(0), [query, open]);
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active row moves with the cursor, which the body finds in the DOM rather than reads
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const run = (c: Command) => {
    setOpen(false);
    c.run();
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40 data-[state=open]:animate-fade" />
        <RadixDialog.Content
          className="fixed z-50 left-1/2 top-[12vh] -translate-x-1/2 w-[min(560px,calc(100vw-32px))] rounded border border-line bg-panel shadow-pop outline-none flex flex-col max-h-[70vh]"
          aria-label="Command palette"
          onKeyDown={e => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor(c => Math.min(shown.length - 1, c + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor(c => Math.max(0, c - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (shown[cursor]) run(shown[cursor]);
            }
          }}
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">Type to narrow, Enter to run.</RadixDialog.Description>
          <div className="flex items-center gap-2 px-3 h-11 border-b border-line">
            <Search size={14} className="text-faint shrink-0" />
            <input
              className="flex-1 bg-transparent outline-none text-sm placeholder:text-faint"
              placeholder={activeConnId ? 'Go to a module, a subject, a stream, a key, …' : 'Go to a module, switch a connection, …'}
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Search commands"
              // biome-ignore lint/a11y/noAutofocus: the palette is the keyboard's; focus is why it opened
              autoFocus
            />
            {searching && <Loader2 size={13} className="animate-spin text-faint shrink-0" aria-label="Searching the connection" />}
            <Kbd>Esc</Kbd>
          </div>
          <div ref={listRef} className="overflow-auto py-1" role="listbox" aria-label="Commands">
            {shown.length === 0 && <div className="px-3 py-4 text-sm text-muted">{searching ? 'Searching…' : 'Nothing matches.'}</div>}
            {shown.map((c, i) => {
              const first = i === 0 || shown[i - 1].group !== c.group;
              return (
                <div key={c.id}>
                  {first && <div className="px-3 pt-2 pb-1 text-2xs uppercase tracking-wide text-faint">{c.group}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === cursor}
                    data-active={i === cursor}
                    className={cn(
                      'w-full text-left px-3 py-1.5 flex items-center gap-2 text-sm',
                      i === cursor ? 'bg-accent/15 text-fg' : 'text-fg/90 hover:bg-field',
                    )}
                    onMouseEnter={() => setCursor(i)}
                    onClick={() => run(c)}
                  >
                    <span className="text-faint shrink-0 w-4 flex justify-center">{c.icon}</span>
                    <span className="truncate">{c.label}</span>
                    {c.hint && <span className="text-xs text-faint truncate ml-auto">{c.hint}</span>}
                  </button>
                </div>
              );
            })}
            {found?.partial && <div className="px-3 pt-2 pb-1 text-xs text-faint">More matches than shown; type more to narrow them.</div>}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
