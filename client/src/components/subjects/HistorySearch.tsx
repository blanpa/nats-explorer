import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { NatsMessage } from 'shared';
import { api, errorMessage } from '../../lib/api';
import { messageKey } from '../../lib/messages';
import { formatCount } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { Input } from '../ui/Input';
import { Segmented } from '../ui/misc';

/** How many hits one search page brings in. */
const SEARCH_PAGE = 200;

export interface SearchState {
  q: string;
  results: NatsMessage[] | null;
  loading: boolean;
  error: string | null;
  /** false searches every subject instead of the selected one */
  scoped: boolean;
  /** the store held more matches before the oldest one shown */
  more: boolean;
  /** an older page of hits is on its way */
  loadingMore: boolean;
}

/** Search field over the recorded history of a subject and everything below it. */
export function useHistorySearch(
  subject: string | null,
  range?: { from: number; to: number } | null,
): SearchState & { setQuery: (q: string) => void; clear: () => void; setScoped: (b: boolean) => void; loadMore: () => void } {
  const [q, setQ] = useState('');
  const [scoped, setScopedState] = useState(true);
  const empty = { results: null, loading: false, error: null, more: false, loadingMore: false };
  const [state, setState] = useState<Omit<SearchState, 'q' | 'scoped'>>(empty);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the search clears on a subject change, which the body itself does not read
  useEffect(() => {
    setQ('');
    setState(empty);
  }, [subject]);

  const run = (next: string, inScope: boolean) => {
    setQ(next);
    if (!next.trim() || (inScope && !subject)) {
      setState(empty);
      return;
    }
    setState(s => ({ ...s, loading: true }));
    api
      // An empty subject searches every subject of every connection.
      .searchHistory(inScope ? (subject ?? '') : '', next.trim(), { limit: SEARCH_PAGE, from: range?.from, to: range?.to })
      .then(res => setState({ results: res.messages, loading: false, error: null, more: !!res.more, loadingMore: false }))
      .catch(err => setState({ results: [], loading: false, error: errorMessage(err), more: false, loadingMore: false }));
  };

  // Hits are newest first, so the last one is the cursor for the next page.
  const loadMore = () => {
    const results = state.results;
    if (!q.trim() || !state.more || state.loadingMore || !results?.length) return;
    const oldest = results[results.length - 1];
    setState(s => ({ ...s, loadingMore: true }));
    api
      .searchHistory(scoped ? (subject ?? '') : '', q.trim(), {
        limit: SEARCH_PAGE,
        from: range?.from,
        to: range?.to,
        // Both halves of the cursor, always: without a range the search
        // still reads from the database when there is one, and that orders
        // by (timestamp, sequence).
        beforeTs: oldest.timestamp,
        beforeSeq: oldest.sequence,
      })
      .then(res =>
        setState(s => {
          const have = new Set((s.results ?? []).map(messageKey));
          return {
            ...s,
            results: [...(s.results ?? []), ...res.messages.filter(m => !have.has(messageKey(m)))],
            more: !!res.more,
            loadingMore: false,
          };
        }),
      )
      .catch(err => setState(s => ({ ...s, loadingMore: false, error: errorMessage(err) })));
  };

  return {
    q,
    scoped,
    ...state,
    setQuery: next => run(next, scoped),
    setScoped: b => {
      setScopedState(b);
      run(q, b);
    },
    clear: () => run('', scoped),
    loadMore,
  };
}

export function HistorySearchInput({ search, placeholder = 'Search history…' }: { search: ReturnType<typeof useHistorySearch>; placeholder?: string }) {
  return (
    <form
      className="relative flex items-center"
      onSubmit={e => {
        e.preventDefault();
        search.setQuery(search.q);
      }}
    >
      <Search size={12} className="absolute left-2 text-faint pointer-events-none" />
      <Input
        inputSize="sm"
        className="pl-6 pr-6 w-56"
        value={search.q}
        onChange={e => search.setQuery(e.target.value)}
        placeholder={placeholder}
        aria-label="Search history"
        title="Subject or payload text over the recorded history; Escape clears"
        onKeyDown={e => e.key === 'Escape' && search.clear()}
      />
      {search.q && (
        <IconButton label="Clear search" size="xs" className="absolute right-0.5" onClick={search.clear}>
          <X size={11} />
        </IconButton>
      )}
    </form>
  );
}

/** The one-line summary above search results, with the scope of the search. */
export function SearchSummary({ search }: { search: ReturnType<typeof useHistorySearch> }) {
  if (search.results === null) return null;
  return (
    <div className="shrink-0 px-3 h-8 flex items-center gap-2 text-xs text-muted border-b border-line">
      {search.loading ? (
        'Searching…'
      ) : search.error ? (
        <span className="text-danger">{search.error}</span>
      ) : (
        `${formatCount(search.results.length)} matching messages for "${search.q}"${search.scoped ? '' : ' across all subjects'}`
      )}
      <span className="ml-auto shrink-0">
        <Segmented
          size="xs"
          value={search.scoped ? 'subject' : 'all'}
          onChange={v => search.setScoped(v === 'subject')}
          options={[
            { id: 'subject', label: 'This subject' },
            { id: 'all', label: 'All subjects' },
          ]}
        />
      </span>
    </div>
  );
}
