import { Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { EmptyState, ErrorState, LoadingState } from '../ui/misc';
import { useCanWrite } from '../../lib/auth';

interface Props {
  keys: string[];
  loading: boolean;
  error: string | null;
  filter: string;
  onFilter: (f: string) => void;
  selected: string | null;
  onSelect: (key: string) => void;
  onDelete: (key: string) => void;
  /** keys ticked for an action on many at once */
  checked: Set<string>;
  onCheck: (key: string, on: boolean) => void;
  /** ticks or clears every key shown */
  onCheckAll: (on: boolean) => void;
}

/** The filterable key list on the left of a bucket, with a tick per key for the actions on many. */
export default function KvKeyList({ keys, loading, error, filter, onFilter, selected, onSelect, onDelete, checked, onCheck, onCheckAll }: Props) {
  const canWrite = useCanWrite();
  const allChecked = keys.length > 0 && keys.every(k => checked.has(k));
  return (
    <div className="w-80 shrink-0 border-r border-line flex flex-col min-h-0">
      <div className="px-2 py-2 border-b border-line flex items-center gap-2">
        {canWrite && keys.length > 0 && (
          <input
            type="checkbox"
            className="checkbox"
            checked={allChecked}
            onChange={e => onCheckAll(e.target.checked)}
            aria-label={allChecked ? 'Untick every key shown' : 'Tick every key shown'}
            title={allChecked ? 'Untick every key shown' : 'Tick every key shown'}
          />
        )}
        <SearchInput value={filter} onChange={ev => onFilter(ev.target.value)} placeholder="Filter keys…" />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState title="Cannot list keys" message={error} />
        ) : keys.length === 0 ? (
          <EmptyState compact title={filter ? 'No matching keys' : 'Bucket is empty'} />
        ) : (
          keys.map(k => (
            <div key={k} className={cn('list-row group py-1 font-mono', selected === k && 'list-row-active')} onClick={() => onSelect(k)}>
              {canWrite && (
                <input
                  type="checkbox"
                  className={cn('checkbox shrink-0', !checked.has(k) && checked.size === 0 && 'opacity-0 group-hover:opacity-100')}
                  checked={checked.has(k)}
                  onClick={ev => ev.stopPropagation()}
                  onChange={ev => onCheck(k, ev.target.checked)}
                  aria-label={`Tick ${k}`}
                />
              )}
              <span className="truncate flex-1">{k}</span>
              <IconButton
                label="Delete key"
                size="xs"
                hidden={!canWrite}
                className="opacity-0 group-hover:opacity-100"
                onClick={ev => {
                  ev.stopPropagation();
                  onDelete(k);
                }}
              >
                <Trash2 size={12} className="text-danger" />
              </IconButton>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
