import { useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '../../lib/utils';

interface Props {
  count: number;
  rowHeight: number;
  renderRow: (index: number) => ReactNode;
  /** stable key per row; defaults to the index */
  rowKey?: (index: number) => string | number;
  className?: string;
  overscan?: number;
  /** rendered above the rows inside the scroll container, sticks to the top */
  header?: ReactNode;
}

/**
 * A scroll container that only mounts the rows in view. Fixed row heights
 * keep the maths trivial, which is what long live lists need.
 */
export function VirtualRows({ count, rowHeight, renderRow, rowKey, className, overscan = 12, header }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  return (
    <div ref={parentRef} className={cn('overflow-auto', className)}>
      {header && <div className="sticky top-0 z-[1]">{header}</div>}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(v => (
          <div
            key={rowKey ? rowKey(v.index) : v.index}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: v.size, transform: `translateY(${v.start}px)` }}
          >
            {renderRow(v.index)}
          </div>
        ))}
      </div>
    </div>
  );
}
