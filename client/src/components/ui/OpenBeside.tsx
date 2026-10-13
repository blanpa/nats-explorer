import { Columns2 } from 'lucide-react';
import type { MouseEvent } from 'react';
import { type SplitModule, useStore } from '../../store';
import { useNarrow } from '../../lib/narrow';
import { cn } from '../../lib/utils';

/**
 * A list row's click: plain opens the item, Ctrl or ⌘ opens it beside the
 * one already open.
 */
export function useRowOpen(module: SplitModule, select: (name: string) => void): (e: MouseEvent, name: string) => void {
  const open = useStore(s => s.openBeside);
  const narrow = useNarrow();
  return (e, name) => {
    if ((e.ctrlKey || e.metaKey) && !narrow) open(module, name);
    else select(name);
  };
}

/** The row's own button for the same, shown on hover, and a mark on the row that is open beside. */
export function OpenBeside({ module, name }: { module: SplitModule; name: string }) {
  const open = useStore(s => s.openBeside);
  const beside = useStore(s => s.beside);
  const narrow = useNarrow();
  if (narrow) return null;
  const isBeside = beside?.module === module && beside.name === name;
  return (
    <button
      type="button"
      className={cn(
        'shrink-0 rounded p-0.5 text-faint hover:text-fg hover:bg-field',
        isBeside ? 'text-accent opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
      )}
      title={isBeside ? 'Open beside' : 'Open beside the one open now (Ctrl-click)'}
      aria-label={`Open ${name} beside`}
      aria-pressed={isBeside}
      onClick={e => {
        e.stopPropagation();
        open(module, name);
      }}
    >
      <Columns2 size={12} />
    </button>
  );
}
