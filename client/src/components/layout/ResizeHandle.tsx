import { useRef, useState } from 'react';
import { useStore } from '../../store';

interface Props {
  /** what is being resized, for the separator's accessible name */
  label: string;
  width: number;
  onChange: (width: number) => void;
  min: number;
  max: number;
  /** width a double-click goes back to */
  reset: number;
}

/**
 * Drag handle between two panes. The pane owns its width (the caller clamps
 * and stores it); the handle only reports the drag. Pointer capture keeps the
 * drag alive over the pane next to it.
 */
export function ResizeHandle({ label, width, onChange, min, max, reset }: Props) {
  const [active, setActive] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    start.current = { x: e.clientX, width };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setActive(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onChange(start.current.width + (e.clientX - start.current.x));
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
      aria-label={`Resize ${label}`}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      className="resize-handle"
      data-active={active}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(reset)}
    />
  );
}

/** The handle between the explorer and the detail pane. */
export default function ExplorerResizeHandle() {
  const width = useStore(s => s.explorerWidth);
  const setWidth = useStore(s => s.setExplorerWidth);
  return <ResizeHandle label="explorer" width={width} onChange={setWidth} min={220} max={800} reset={340} />;
}
