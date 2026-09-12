import { Plus } from 'lucide-react';
import type { ConnectionStatus } from 'shared';
import { serverLabel, type SavedConnection } from '../../lib/savedConnections';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';

interface Props {
  items: SavedConnection[];
  live: Map<string, ConnectionStatus>;
  selectedId: string | null;
  /** an unsaved draft shown at the end of the list */
  draft: SavedConnection | null;
  onSelect: (item: SavedConnection) => void;
  onNew: () => void;
}

/** The saved connections on the left of the dialog, with their live status. */
export default function SavedConnectionList({ items, live, selectedId, draft, onSelect, onNew }: Props) {
  return (
    <div className="w-60 shrink-0 border-r border-line flex flex-col min-h-0">
      <div className="flex items-center justify-between px-3 h-10 border-b border-line">
        <span className="pane-title">Saved</span>
        <Button size="xs" variant="ghost" icon={<Plus size={12} />} onClick={onNew}>
          New
        </Button>
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
