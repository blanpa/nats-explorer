import { useEffect, useRef, type ReactNode } from 'react';
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
  /** rendered under the rows, e.g. the state of a page being loaded */
  footer?: ReactNode;
  /** called once the last rows come into view, to page in what follows */
  onEndReached?: () => void;
  /** how many rows before the end already count as "reached" */
  endThreshold?: number;
  /** told when the list is scrolled away from its first rows, and when it is back */
  onScrolledAway?: (away: boolean) => void;
}

/**
 * A scroll container that only mounts the rows in view. Fixed row heights
 * keep the maths trivial, which is what long live lists need.
 */
export function VirtualRows({
  count,
  rowHeight,
  renderRow,
  rowKey,
  className,
  overscan = 12,
  header,
  footer,
  onEndReached,
  endThreshold = 5,
  onScrolledAway,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  // Paging is driven by what is rendered, not by scroll events: the last row
  // being mounted is exactly the moment more is needed. The caller decides
  // whether there is anything left to fetch. The callback lives in a ref so
  // an inline arrow does not fire it on every render.
  const items = virtualizer.getVirtualItems();
  const lastRendered = items.length ? items[items.length - 1].index : -1;
  const endReached = useRef(onEndReached);
  endReached.current = onEndReached;
  useEffect(() => {
    // A few rows early, so the next page is on its way before the list runs out.
    if (count > 0 && lastRendered >= count - 1 - endThreshold) endReached.current?.();
  }, [lastRendered, count, endThreshold]);

  // Whether the reader has left the first rows behind. It is reported on
  // the way out and on the way back, once per crossing rather than per
  // scroll event, so a caller can turn something on and off with it.
  const away = useRef(false);
  const scrolledAway = useRef(onScrolledAway);
  scrolledAway.current = onScrolledAway;
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const next = e.currentTarget.scrollTop > rowHeight * 2;
    if (next === away.current) return;
    away.current = next;
    scrolledAway.current?.(next);
  };

  return (
    <div ref={parentRef} className={cn('overflow-auto', className)} onScroll={onScrolledAway ? onScroll : undefined}>
      {header && <div className="sticky top-0 z-[1]">{header}</div>}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map(v => (
          <div
            key={rowKey ? rowKey(v.index) : v.index}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: v.size, transform: `translateY(${v.start}px)` }}
          >
            {renderRow(v.index)}
          </div>
        ))}
      </div>
      {footer}
    </div>
  );
}
