import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eraser, Eye, EyeOff, Network } from 'lucide-react';
import { useStore } from '../../store';
import { cn, previewPayload } from '../../lib/utils';
import { IconButton } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { EmptyState, PaneHeader } from '../ui/misc';
import { ancestorsOf, buildTree, collectBranchPaths, filterTree, flattenTree, isSystemRoot, type FlatNode } from './tree';

const ROW_HEIGHT = 24;
const INDENT = 14;

const toneClass = {
  str: 'text-syn-str',
  num: 'text-syn-num',
  bool: 'text-syn-bool',
  null: 'text-syn-null',
  obj: 'text-muted',
  bin: 'text-muted italic',
} as const;

const Row = memo(function Row({
  item,
  selected,
  multiConn,
  colorOf,
  onSelect,
  onToggle,
}: {
  item: FlatNode;
  selected: boolean;
  multiConn: boolean;
  colorOf: (id: string) => string | undefined;
  onSelect: (subject: string) => void;
  onToggle: (subject: string) => void;
}) {
  const { node, depth, hasChildren, expanded, guides } = item;
  const preview = node.last && !hasChildren ? previewPayload(node.last.payload, node.last.payloadType, 80) : null;
  // Leaves show their own rate; branches show the aggregate so hot subtrees stand out even when collapsed.
  const rate = hasChildren ? node.totalRate : node.rate;

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
      className={cn('tree-row relative', selected && 'tree-row-selected')}
      style={{ paddingLeft: 8 + depth * INDENT }}
      onClick={() => onSelect(node.fullSubject)}
      onDoubleClick={() => hasChildren && onToggle(node.fullSubject)}
    >
      {guides.map((cont, i) => cont && <span key={i} className="tree-guide" style={{ left: 8 + i * INDENT + 7 }} />)}
      {hasChildren ? (
        <button
          className="tree-toggle mr-1"
          onClick={e => {
            e.stopPropagation();
            onToggle(node.fullSubject);
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
      {multiConn && node.connIds.length === 1 && <span className="status-dot mr-1.5 !w-1.5 !h-1.5" style={{ background: colorOf(node.connIds[0]) }} />}
      <span className="tree-label">{node.segment}</span>
      {node.total > 0 && <span className="tree-count ml-1.5">{node.total.toLocaleString()}</span>}
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

export default function SubjectTree() {
  const index = useStore(s => s.subjectIndex);
  const treeVersion = useStore(s => s.treeVersion);
  const filter = useStore(s => s.subjectFilter);
  const setFilter = useStore(s => s.setSubjectFilter);
  const hideSystem = useStore(s => s.hideSystemSubjects);
  const setHideSystem = useStore(s => s.setHideSystemSubjects);
  const selected = useStore(s => s.selectedSubject);
  const setSelected = useStore(s => s.setSelectedSubject);
  const expanded = useStore(s => s.expanded);
  const toggleExpanded = useStore(s => s.toggleExpanded);
  const setExpanded = useStore(s => s.setExpanded);
  const clearMessages = useStore(s => s.clearMessages);
  const connections = useStore(s => s.connections);
  const parentRef = useRef<HTMLDivElement>(null);
  const autoExpandedRef = useRef(false);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const merged = useMemo(() => buildTree(index), [index, treeVersion]);
  const filtering = filter.trim().length > 0;
  // System roots stay hidden unless the user asks for them, or the filter clearly targets them.
  const filterWantsSystem = /^[\s]*[$_]/.test(filter);
  const systemCount = useMemo(() => merged.filter(n => isSystemRoot(n.segment)).length, [merged]);
  const visible = useMemo(() => (hideSystem && !filterWantsSystem ? merged.filter(n => !isSystemRoot(n.segment)) : merged), [merged, hideSystem, filterWantsSystem]);
  const filtered = useMemo(() => filterTree(visible, filter), [visible, filter]);

  // Expand the first level once when data first arrives.
  useEffect(() => {
    if (autoExpandedRef.current || merged.length === 0) return;
    autoExpandedRef.current = true;
    if (expanded.size === 0) setExpanded(merged.map(n => n.fullSubject));
  }, [merged, expanded.size, setExpanded]);

  const isExpanded = useCallback(
    (path: string) => (filtering ? true : expanded.has(path)),
    [expanded, filtering],
  );
  const flat = useMemo(() => flattenTree(filtered, isExpanded), [filtered, isExpanded]);

  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  // Keep the selected row visible when it changes externally.
  const selectedIndex = useMemo(() => flat.findIndex(f => f.node.fullSubject === selected), [flat, selected]);
  useLayoutEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]);

  const anyConnected = connections.some(c => c.connected);
  const multiConn = connections.filter(c => c.connected).length > 1;
  const colorOf = useCallback((id: string) => connections.find(c => c.id === id)?.color, [connections]);

  const expandAll = () => setExpanded(collectBranchPaths(merged));
  const collapseAll = () => setExpanded([]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (flat.length === 0) return;
    const idx = selectedIndex;
    const go = (i: number) => {
      const target = flat[Math.max(0, Math.min(flat.length - 1, i))];
      if (target) setSelected(target.node.fullSubject);
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
        if (cur.hasChildren && !cur.expanded) toggleExpanded(cur.node.fullSubject);
        else if (cur.hasChildren) go(idx + 1);
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        const cur = flat[idx];
        if (!cur) break;
        if (cur.hasChildren && cur.expanded) toggleExpanded(cur.node.fullSubject);
        else {
          const parent = ancestorsOf(cur.node.fullSubject).pop();
          if (parent) setSelected(parent);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        const cur = flat[idx];
        if (cur?.hasChildren) {
          e.preventDefault();
          toggleExpanded(cur.node.fullSubject);
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
            <IconButton label="Expand all" size="xs" onClick={expandAll}>
              <ChevronsUpDown size={13} />
            </IconButton>
            <IconButton label="Collapse all" size="xs" onClick={collapseAll}>
              <ChevronsDownUp size={13} />
            </IconButton>
            <IconButton label="Clear buffered messages" size="xs" onClick={() => clearMessages()}>
              <Eraser size={13} />
            </IconButton>
          </>
        }
      />
      <div className="px-2 py-2 border-b border-line">
        <SearchInput value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter subjects…" aria-label="Filter subjects" />
      </div>

      {flat.length === 0 ? (
        <EmptyState
          compact
          icon={Network}
          title={filtering ? 'No matching subjects' : !anyConnected ? 'Not connected' : hideSystem && systemCount > 0 ? 'Only system subjects so far' : 'Waiting for messages'}
          description={
            filtering
              ? 'Try a shorter filter. Multiple words are combined.'
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
          onKeyDown={onKeyDown}
          className="flex-1 min-h-0 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-accent/60 py-1"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(v => {
              const item = flat[v.index];
              return (
                <div key={item.node.fullSubject} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: v.size, transform: `translateY(${v.start}px)` }}>
                  <Row
                    item={item}
                    selected={selected === item.node.fullSubject}
                    multiConn={multiConn}
                    colorOf={colorOf}
                    onSelect={setSelected}
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
