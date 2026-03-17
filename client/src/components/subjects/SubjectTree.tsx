import { useMemo, useRef, useCallback } from 'react';
import { useStore, SubjectNode } from '../../store';
import { useVirtualizer } from '@tanstack/react-virtual';
import SubjectNodeComponent from './SubjectNodeComponent';

function mergeTrees(trees: Map<string, SubjectNode[]>): SubjectNode[] {
  const merged: Map<string, SubjectNode> = new Map();
  for (const tree of trees.values()) {
    for (const node of tree) {
      mergeNode(merged, node);
    }
  }
  return [...merged.values()].sort((a, b) => a.segment.localeCompare(b.segment));
}

function mergeNode(level: Map<string, SubjectNode>, node: SubjectNode): void {
  const existing = level.get(node.segment);
  if (existing) {
    existing.messageCount += node.messageCount;
    existing.rate += node.rate;
    if (node.lastMessage && (!existing.lastMessage || node.lastMessage.timestamp > existing.lastMessage.timestamp)) {
      existing.lastMessage = node.lastMessage;
    }
    const childMap = new Map<string, SubjectNode>();
    for (const c of existing.children) childMap.set(c.segment, c);
    for (const c of node.children) mergeNode(childMap, c);
    existing.children = [...childMap.values()].sort((a, b) => a.segment.localeCompare(b.segment));
  } else {
    level.set(node.segment, { ...node, children: [...node.children] });
  }
}

interface FlatNode {
  node: SubjectNode;
  depth: number;
  key: string;
}

function filterTree(nodes: SubjectNode[], filter: string): SubjectNode[] {
  if (!filter) return nodes;
  return nodes
    .map(node => {
      const matchesSelf = node.fullSubject.toLowerCase().includes(filter.toLowerCase());
      const filteredChildren = filterTree(node.children, filter);
      if (matchesSelf || filteredChildren.length > 0) {
        return { ...node, children: matchesSelf ? node.children : filteredChildren };
      }
      return null;
    })
    .filter(Boolean) as SubjectNode[];
}

export default function SubjectTree() {
  const subjectTrees = useStore(s => s.subjectTrees);
  const subjectFilter = useStore(s => s.subjectFilter);
  const selectedSubject = useStore(s => s.selectedSubject);
  const setSelectedSubject = useStore(s => s.setSelectedSubject);
  const parentRef = useRef<HTMLDivElement>(null);

  // Track expanded state externally for virtualization
  const expandedRef = useRef(new Set<string>());

  const mergedTree = useMemo(() => mergeTrees(subjectTrees), [subjectTrees]);
  const filtered = useMemo(() => filterTree(mergedTree, subjectFilter), [mergedTree, subjectFilter]);

  // Flatten tree for virtualization, respecting expanded state
  const flatNodes = useMemo(() => {
    const result: FlatNode[] = [];
    const flatten = (nodes: SubjectNode[], depth: number) => {
      for (const node of nodes) {
        result.push({ node, depth, key: node.fullSubject });
        // Auto-expand first level, or if manually expanded
        const isExpanded = depth === 0
          ? !expandedRef.current.has('_collapsed_' + node.fullSubject)
          : expandedRef.current.has(node.fullSubject);
        if (node.children.length > 0 && isExpanded) {
          flatten(node.children, depth + 1);
        }
      }
    };
    flatten(filtered, 0);
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, selectedSubject]); // re-flatten when selection changes (triggers toggle)

  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 24,
    overscan: 20,
  });

  const toggleExpand = useCallback((fullSubject: string, depth: number) => {
    if (depth === 0) {
      // Root level: default expanded, track collapse
      const collapseKey = '_collapsed_' + fullSubject;
      if (expandedRef.current.has(collapseKey)) {
        expandedRef.current.delete(collapseKey);
      } else {
        expandedRef.current.add(collapseKey);
      }
    } else {
      if (expandedRef.current.has(fullSubject)) {
        expandedRef.current.delete(fullSubject);
      } else {
        expandedRef.current.add(fullSubject);
      }
    }
    // Force re-render by touching selection
    setSelectedSubject(useStore.getState().selectedSubject);
  }, [setSelectedSubject]);

  if (flatNodes.length === 0) {
    return (
      <div className="tree-empty">
        {subjectFilter ? 'No matching subjects' : 'Waiting for messages...'}
      </div>
    );
  }

  return (
    <div ref={parentRef} className="tree-root" style={{ height: '100%', overflow: 'auto' }}>
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map(virtualRow => {
          const { node, depth, key } = flatNodes[virtualRow.index];
          const hasChildren = node.children.length > 0;
          const isExpanded = depth === 0
            ? !expandedRef.current.has('_collapsed_' + node.fullSubject)
            : expandedRef.current.has(node.fullSubject);

          return (
            <div
              key={key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <SubjectNodeComponent
                node={node}
                depth={depth}
                isExpanded={isExpanded}
                onToggle={() => toggleExpand(node.fullSubject, depth)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
