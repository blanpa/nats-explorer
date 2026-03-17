import { memo, useCallback } from 'react';
import { useStore, SubjectNode } from '../../store';

function getValuePreview(node: SubjectNode): { text: string; className: string } | null {
  if (!node.lastMessage) return null;
  const payload = node.lastMessage.payload;
  if (!payload) return null;

  if (node.lastMessage.payloadType === 'json') {
    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed === 'number') return { text: String(parsed), className: 'value-number' };
      if (typeof parsed === 'boolean') return { text: String(parsed), className: 'value-boolean' };
      if (typeof parsed === 'string') return { text: `"${parsed.substring(0, 30)}"`, className: 'value-string' };
      if (parsed === null) return { text: 'null', className: 'value-null' };
      const compact = JSON.stringify(parsed);
      return { text: compact.length > 40 ? compact.substring(0, 40) + '...' : compact, className: 'value-object' };
    } catch {}
  }

  if (node.lastMessage.payloadType === 'binary') {
    return { text: `<${node.lastMessage.size} bytes>`, className: 'value-binary' };
  }

  const truncated = payload.length > 40 ? payload.substring(0, 40) + '...' : payload;
  return { text: truncated, className: 'value-string' };
}

function getTotalCount(node: SubjectNode): number {
  let count = node.messageCount;
  for (const child of node.children) count += getTotalCount(child);
  return count;
}

interface Props {
  node: SubjectNode;
  depth: number;
  isExpanded?: boolean;
  onToggle?: () => void;
}

export default memo(function SubjectNodeComponent({ node, depth, isExpanded, onToggle }: Props) {
  const selectedSubject = useStore(s => s.selectedSubject);
  const setSelectedSubject = useStore(s => s.setSelectedSubject);
  const hasChildren = node.children.length > 0;
  const isSelected = selectedSubject === node.fullSubject;
  const valuePreview = getValuePreview(node);
  const totalCount = getTotalCount(node);

  const handleClick = useCallback(() => {
    setSelectedSubject(node.fullSubject);
  }, [node.fullSubject, setSelectedSubject]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle?.();
  }, [onToggle]);

  return (
    <div
      className={`tree-node ${isSelected ? 'tree-node-selected' : ''}`}
      style={{ paddingLeft: depth * 16 + 4 }}
      onClick={handleClick}
    >
      {hasChildren ? (
        <span className="tree-toggle" onClick={handleToggle}>
          {isExpanded ? '▾' : '▸'}
        </span>
      ) : (
        <span className="tree-leaf-dot" />
      )}
      <span className="tree-node-label">{node.segment}</span>
      {totalCount > 0 && (
        <span className="tree-node-count">({totalCount})</span>
      )}
      {valuePreview && (
        <span className={`tree-node-value ${valuePreview.className}`}>
          {valuePreview.text}
        </span>
      )}
      {node.rate > 0 && (
        <span className="tree-node-activity" title={`${node.rate.toFixed(1)} msg/s`}>
          <span
            className="tree-node-activity-bar"
            style={{ width: Math.min(node.rate * 4, 40) + 'px', opacity: Math.min(0.3 + node.rate * 0.15, 1) }}
          />
          {node.rate > 0.5 && <span className="tree-node-rate">{node.rate.toFixed(1)}/s</span>}
        </span>
      )}
    </div>
  );
});
