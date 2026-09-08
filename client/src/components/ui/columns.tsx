import { useCallback, useState } from 'react';
import { readSetting, writeSetting } from '../../lib/utils';

export type ColumnWidths<K extends string> = Record<K, number>;

/**
 * Column widths that the user can drag, remembered per list under `key`.
 * `resize` returns the pointer handlers for a grip at a column's right edge:
 * dragging changes that column; a double click restores the default.
 */
export function useColumnWidths<K extends string>(key: string, defaults: ColumnWidths<K>, min = 48) {
  const [widths, setWidths] = useState<ColumnWidths<K>>(() => ({ ...defaults, ...readSetting<Partial<ColumnWidths<K>>>(key, {}) }));

  const resize = useCallback(
    (col: K) => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const start = widths[col];
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        let next = start;
        const move = (ev: PointerEvent) => {
          next = Math.max(min, Math.round(start + ev.clientX - startX));
          setWidths(w => ({ ...w, [col]: next }));
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          writeSetting(key, { ...widths, [col]: next });
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      },
      onDoubleClick: () => {
        const reset = { ...widths, [col]: defaults[col] };
        setWidths(reset);
        writeSetting(key, reset);
      },
    }),
    [widths, key, defaults, min],
  );

  return { widths, resize };
}

/** The drag grip at the right edge of a header cell. */
export function ColumnGrip(props: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    // Mouse-only affordance; the widths have keyboard-free defaults.
    <span
      aria-hidden
      className="absolute top-0 bottom-0 -right-2 w-4 cursor-col-resize group/grip flex justify-center"
      title="Drag to resize, double-click to reset"
      {...props}
    >
      <span className="w-px h-full bg-line group-hover/grip:bg-accent group-active/grip:bg-accent" />
    </span>
  );
}
