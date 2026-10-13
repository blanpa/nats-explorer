import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Import, Plus } from 'lucide-react';
import type { CliContext, ConnectionStatus } from 'shared';
import { serverLabel, type SavedConnection } from '../../lib/savedConnections';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { menuClass, menuItemClass } from '../ui/misc';

interface Props {
  items: SavedConnection[];
  live: Map<string, ConnectionStatus>;
  selectedId: string | null;
  /** an unsaved draft shown at the end of the list */
  draft: SavedConnection | null;
  onSelect: (item: SavedConnection) => void;
  onNew: () => void;
  /** the nats CLI's contexts on the backend's machine, offered as a start */
  contexts?: CliContext[];
  onImport?: (ctx: CliContext) => void;
}

/** The saved connections on the left of the dialog, with their live status. */
export default function SavedConnectionList({ items, live, selectedId, draft, onSelect, onNew, contexts, onImport }: Props) {
  return (
    <div className="w-60 shrink-0 border-r border-line flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 h-10 border-b border-line">
        <span className="pane-title">Saved</span>
        <span className="flex items-center gap-0.5">
          {contexts && contexts.length > 0 && onImport && (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <Button size="xs" variant="ghost" icon={<Import size={12} />} title="Start from a context of the nats CLI on this machine">
                  Context
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className={menuClass} align="end" sideOffset={4}>
                  {contexts.map(c => (
                    <DropdownMenu.Item key={c.name} className={menuItemClass} onSelect={() => onImport(c)} title={c.description || c.servers.join(', ')}>
                      <span className="truncate">{c.name}</span>
                      <span className="text-xs text-faint font-mono truncate ml-auto">{c.servers[0]?.replace(/^(nats|tls):\/\//, '')}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
          <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={onNew}>
            New
          </Button>
        </span>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {items.map(item => {
          const l = live.get(item.id);
          return (
            <button
              type="button"
              key={item.id}
              onClick={() => onSelect(item)}
              className={cn('list-row w-full text-left', selectedId === item.id && 'list-row-active')}
            >
              <span className="status-dot" style={{ background: l?.connected ? l.color : l ? 'rgb(var(--warn))' : 'rgb(var(--fg-faint))' }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.name || serverLabel(item)}</span>
                <span className="block truncate text-xs text-muted font-mono">{serverLabel(item)}</span>
              </span>
            </button>
          );
        })}
        {draft && (
          <div className="list-row list-row-active">
            <span className="status-dot bg-faint" />
            <span className="min-w-0 flex-1 truncate italic text-muted">{draft.name || 'New connection'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
