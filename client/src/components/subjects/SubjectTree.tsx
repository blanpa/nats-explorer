import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eraser, Eye, EyeOff, Network, Quote } from 'lucide-react';
import { useStore } from '../../store';
import { clearHistory } from '../../lib/feed';
import { errorMessage } from '../../lib/api';
import { cn, formatCount, previewPayload } from '../../lib/utils';
import { toast } from '../ui/Toast';
import { IconButton } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { confirm } from '../ui/Dialog';
import { EmptyState, PaneHeader } from '../ui/misc';
import { toneClass } from '../ui/tone';
import { ancestorsOf, type FlatNode } from './tree';
import BookmarksPanel from './BookmarksPanel';
import PayloadFilter from './PayloadFilter';
import SubscriptionsPanel from './SubscriptionsPanel';
import { useCanWrite } from '../../lib/auth';

const ROW_HEIGHT = 24;
const INDENT = 14;

const Row = memo(function Row({
  item,
  selected,
  multiConn,
  showPreview,
  colorOf,
  onSelect,
  onToggle,
}: {
  item: FlatNode;
  selected: boolean;
  multiConn: boolean;
  showPreview: boolean;
  colorOf: (id: string) => string | undefined;
  onSelect: (subject: string, add: boolean) => void;
  onToggle: (subject: string) => void;
}) {
  const { depth, hasChildren, expanded, guides } = item;
  const preview = showPreview && item.last && !hasChildren ? previewPayload(item.last.payload, item.last.payloadType, 80) : null;
  // Leaves show their own rate; branches show the aggregate so hot subtrees stand out even when collapsed.
  const rate = hasChildren ? item.totalRate : item.rate;

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
      className={cn('tree-row relative', selected && 'tree-row-selected')}
      style={{ paddingLeft: 8 + depth * INDENT }}
      onClick={e => onSelect(item.subject, e.ctrlKey || e.metaKey)}
      onDoubleClick={() => hasChildren && onToggle(item.subject)}
    >
      {guides.map((cont, i) => cont && <span key={i} className="tree-guide" style={{ left: 8 + i * INDENT + 7 }} />)}
      {hasChildren ? (
        <button
          type="button"
          className="tree-toggle mr-1"
          onClick={e => {
            e.stopPropagation();
            onToggle(item.subject);
          }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          tabIndex={-1}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      ) : (
        <span className="w-4 h-4 mr-1 shrink-0 flex items-center justify-center">
          <span className="w-1 h-1 rounded-full bg-faint" />
        </span>
      )}
      {multiConn && item.connIds.length === 1 && <span className="status-dot mr-1.5 w-1.5! h-1.5!" style={{ background: colorOf(item.connIds[0]) }} />}
      <span className="tree-label">{item.segment}</span>
      {item.total > 0 && (
        <span className="tree-count ml-1.5" title={`${formatCount(item.total)} message${item.total === 1 ? '' : 's'}${hasChildren ? ' in this branch' : ''}`}>
          {formatCount(item.total)}
        </span>
      )}
      {/* How much is under a branch, without having to open it. */}
      {hasChildren && item.subjects > 0 && (
        <span className="tree-count ml-1.5 opacity-70" title={`${formatCount(item.subjects)} subject${item.subjects === 1 ? '' : 's'} with messages below`}>
          · {formatCount(item.subjects)} subj
        </span>
      )}
      {preview && <span className={cn('tree-value ml-2', toneClass[preview.tone])}>{preview.text}</span>}
      {rate >= 0.5 && (
        <span
          className={cn('tree-rate ml-auto pl-2', rate >= 10 && 'tree-rate-hot', hasChildren && expanded && 'opacity-50')}
          title={`${rate.toFixed(1)} msg/s${hasChildren ? ' in this branch' : ''}`}
        >
          {rate < 10 ? rate.toFixed(1) : Math.round(rate)}/s
        </span>
      )}
    </div>
  );
});

/**
 * The subject tree. Rows come laid out from the feed worker for the current
 * view (expanded branches, filter, system toggle); the server only sends the
 * nodes that view needs, so a huge namespace costs what is on screen.
 */
export default function SubjectTree() {
  const canWrite = useCanWrite();
  const flat = useStore(s => s.treeRows);
  const systemCount = useStore(s => s.systemCount);
  const filter = useStore(s => s.subjectFilter);
  const setFilter = useStore(s => s.setSubjectFilter);
  const hideSystem = useStore(s => s.hideSystemSubjects);
  const setHideSystem = useStore(s => s.setHideSystemSubjects);
  const treePreview = useStore(s => s.treePreview);
  const setTreePreview = useStore(s => s.setTreePreview);
  const selected = useStore(s => s.selectedSubject);
  const selectedSubjects = useStore(s => s.selectedSubjects);
  const setSelected = useStore(s => s.setSelectedSubject);
  const toggleSelected = useStore(s => s.toggleSelectedSubject);
  // Ctrl/Cmd-click adds a subject to the ones being watched.
  const onSelect = useCallback((subject: string, add: boolean) => (add ? toggleSelected(subject) : setSelected(subject)), [setSelected, toggleSelected]);
  const expandAll = useStore(s => s.expandAll);
  const toggleExpanded = useStore(s => s.toggleExpanded);
  const setExpanded = useStore(s => s.setExpanded);
  const expandAllBranches = useStore(s => s.expandAllBranches);
  const collapseAll = useStore(s => s.collapseAll);
  const connections = useStore(s => s.connections);
  const parentRef = useRef<HTMLDivElement>(null);
  const autoExpandedRef = useRef(false);

  const expr = useStore(s => s.subjectExpr);
  const filtering = filter.trim().length > 0 || expr.trim().length > 0;

  // Expand the first level when data arrives, and again after the tree
  // started over (subscription change, reconnect).
  useEffect(() => {
    if (flat.length === 0) {
      autoExpandedRef.current = false;
      return;
    }
    if (autoExpandedRef.current || filtering) return;
    autoExpandedRef.current = true;
    if (!expandAll) setExpanded(flat.filter(r => r.depth === 0).map(r => r.subject));
  }, [flat, filtering, expandAll, setExpanded]);

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  // Keep the selected row visible when it changes externally.
  const selectedIndex = useMemo(() => flat.findIndex(f => f.subject === selected), [flat, selected]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolling follows the index; the virtualizer identity must not retrigger it
  useLayoutEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [selectedIndex]);

  const anyConnected = connections.some(c => c.connected);
  const multiConn = connections.filter(c => c.connected).length > 1;
  const colorOf = useCallback((id: string) => connections.find(c => c.id === id)?.color, [connections]);

  // Clearing everything empties the tree as well: a subject with a count and
  // no messages behind it says less than an empty tree. It reaches the disk
  // too, so it is worth asking first.
  const clearAll = async () => {
    const ok = await confirm({
      title: 'Clear the whole message history?',
      message: 'Every recorded message is forgotten, in memory and on disk, and the subject tree starts over. Subjects come back as they send again.',
      confirmLabel: 'Clear',
      danger: true,
    });
    if (!ok) return;
    try {
      await clearHistory();
      toast.success('History cleared', 'The tree starts over with the next message.');
    } catch (err) {
      toast.error('Clear failed', errorMessage(err));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (flat.length === 0) return;
    const idx = selectedIndex;
    const go = (i: number) => {
      const target = flat[Math.max(0, Math.min(flat.length - 1, i))];
      if (target) setSelected(target.subject);
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        go(idx < 0 ? 0 : idx + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        go(idx < 0 ? 0 : idx - 1);
        break;
      case 'Home':
        e.preventDefault();
        go(0);
        break;
      case 'End':
        e.preventDefault();
        go(flat.length - 1);
        break;
      case 'ArrowRight': {
        e.preventDefault();
        const cur = flat[idx];
        if (!cur) break;
        if (cur.hasChildren && !cur.expanded) toggleExpanded(cur.subject);
        else if (cur.hasChildren) go(idx + 1);
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        const cur = flat[idx];
        if (!cur) break;
        if (cur.hasChildren && cur.expanded) toggleExpanded(cur.subject);
        else {
          const parent = ancestorsOf(cur.subject).pop();
          if (parent) setSelected(parent);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        const cur = flat[idx];
        if (cur?.hasChildren) {
          e.preventDefault();
          toggleExpanded(cur.subject);
        }
        break;
      }
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <PaneHeader
        title="Subjects"
        actions={
          <>
            <IconButton
              label={hideSystem ? `Show system subjects${systemCount ? ` (${systemCount} hidden)` : ''}` : 'Hide system subjects ($…, _INBOX)'}
              size="xs"
              onClick={() => setHideSystem(!hideSystem)}
              className={cn(!hideSystem && 'text-accent')}
            >
              {hideSystem ? <EyeOff size={13} /> : <Eye size={13} />}
            </IconButton>
            <IconButton
              label={treePreview ? 'Hide the last payload in the tree' : 'Show the last payload next to each subject'}
              size="xs"
              onClick={() => setTreePreview(!treePreview)}
              className={cn(treePreview && 'text-accent')}
            >
              <Quote size={13} />
            </IconButton>
            <IconButton label="Expand all" size="xs" onClick={expandAllBranches}>
              <ChevronsUpDown size={13} />
            </IconButton>
            <IconButton label="Collapse all" size="xs" onClick={collapseAll}>
              <ChevronsDownUp size={13} />
            </IconButton>
            {canWrite && (
              <IconButton label="Clear message history" size="xs" onClick={clearAll}>
                <Eraser size={13} />
              </IconButton>
            )}
          </>
        }
      />
      <SubscriptionsPanel />
      <BookmarksPanel />
      <PayloadFilter />
      <div className="px-2 py-2 border-b border-line">
        <SearchInput
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter subjects…  /"
          aria-label="Filter subjects"
          title="Press / to focus, Escape to clear"
        />
      </div>

      {flat.length === 0 ? (
        <EmptyState
          compact
          icon={Network}
          title={
            filtering
              ? 'No matching subjects'
              : !anyConnected
                ? 'Not connected'
                : hideSystem && systemCount > 0
                  ? 'Only system subjects so far'
                  : 'Waiting for messages'
          }
          description={
            filtering
              ? expr.trim()
                ? 'No subject whose last message satisfies the payload filter.'
                : 'Try a shorter filter. Multiple words are combined.'
              : !anyConnected
                ? 'Live subjects show up here once a connection is open.'
                : hideSystem && systemCount > 0
                  ? `${systemCount} internal root${systemCount === 1 ? '' : 's'} ($…, _INBOX) are hidden. Use the eye icon to show them.`
                  : 'Subjects appear here as soon as messages arrive on the subscribed subjects.'
          }
        />
      ) : (
        <div
          ref={parentRef}
          role="tree"
          tabIndex={0}
          aria-label="Subject tree"
          aria-multiselectable="true"
          onKeyDown={onKeyDown}
          className="flex-1 min-h-0 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-accent/60 py-1"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(v => {
              const item = flat[v.index];
              return (
                <div key={item.subject} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: v.size, transform: `translateY(${v.start}px)` }}>
                  <Row
                    item={item}
                    selected={selectedSubjects.includes(item.subject)}
                    multiConn={multiConn}
                    showPreview={treePreview}
                    colorOf={colorOf}
                    onSelect={onSelect}
                    onToggle={toggleExpanded}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
