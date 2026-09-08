import { useRef, useState } from 'react';
import { useStore } from '../../store';

export default function ResizeHandle() {
  const setWidth = useStore(s => s.setExplorerWidth);
  const width = useStore(s => s.explorerWidth);
  const [active, setActive] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, width: useStore.getState().explorerWidth };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setActive(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    setWidth(start.current.width + (e.clientX - start.current.x));
  };
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    setActive(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize explorer"
      aria-valuenow={width}
      aria-valuemin={220}
      aria-valuemax={800}
      className="resize-handle"
      data-active={active}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => setWidth(340)}
    />
  );
}
