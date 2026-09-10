import { useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { byGroup, useBookmarks } from '../../lib/bookmarks';
import { cn, readSetting, writeSetting } from '../../lib/utils';
import { useStore } from '../../store';
import { IconButton } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { SubjectText } from '../ui/SubjectText';

const OPEN_KEY = 'ne.bookmarksOpen';
const FILTER_FROM = 10;

/**
 * The bookmarked subjects, grouped. Selecting one works even when it is not
 * in the current tree view, which is the point: a filter is not a way back
 * to the subject you look at every morning.
 */
export default function BookmarksPanel() {
  const items = useBookmarks(s => s.items);
  const remove = useBookmarks(s => s.remove);
  const selected = useStore(s => s.selectedSubject);
  const setSelected = useStore(s => s.revealSubject);
  // Open by itself once there is something to show; a stored choice wins.
  const [open, setOpen] = useState<boolean | null>(() => readSetting<boolean | null>(OPEN_KEY, null));
  const [filter, setFilter] = useState('');

  if (items.length === 0) return null;
  const isOpen = open ?? true;

  const toggle = () => {
    writeSetting(OPEN_KEY, !isOpen);
    setOpen(!isOpen);
  };
  const term = filter.trim().toLowerCase();
  const shown = term ? items.filter(b => `${b.subject} ${b.label ?? ''} ${b.group ?? ''}`.toLowerCase().includes(term)) : items;

  return (
    <div className="border-b border-line" role="group" aria-label="Bookmarks">
      <button type="button" className="w-full flex items-center gap-1.5 h-7 px-2 text-xs text-muted hover:text-fg" onClick={toggle} aria-expanded={isOpen}>
        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="font-semibold shrink-0">Bookmarks</span>
        <span className="ml-auto tabular-nums text-faint shrink-0">{items.length}</span>
      </button>
      {isOpen && (
        <>
          {items.length >= FILTER_FROM && (
            <div className="px-2 pb-1">
              <SearchInput value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter bookmarks…" aria-label="Filter bookmarks" />
            </div>
          )}
          <div className="pb-1 max-h-56 overflow-auto">
            {byGroup(shown).map(([group, list]) => (
              <div key={group || 'ungrouped'}>
                {group && <div className="px-2 pt-1 pb-0.5 text-2xs uppercase tracking-wide text-faint">{group}</div>}
                {list.map(b => (
                  <div
                    key={b.subject}
                    className={cn('list-row group py-1 gap-1', selected === b.subject && 'list-row-active')}
                    onClick={() => setSelected(b.subject)}
                    title={b.note ? `${b.subject}\n${b.note}` : b.subject}
                  >
                    {b.label ? (
                      <span className="truncate flex-1 text-xs">{b.label}</span>
                    ) : (
                      <SubjectText subject={b.subject} className="truncate flex-1 text-xs" />
                    )}
                    <IconButton
                      label={`Remove the bookmark for ${b.subject}`}
                      size="xs"
                      className="shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={e => {
                        e.stopPropagation();
                        remove(b.subject);
                      }}
                    >
                      <X size={11} />
                    </IconButton>
                  </div>
                ))}
              </div>
            ))}
            {shown.length === 0 && <div className="px-2 py-1.5 text-xs text-faint">No bookmark matches.</div>}
          </div>
        </>
      )}
    </div>
  );
}
