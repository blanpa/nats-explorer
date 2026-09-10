import { useCallback, useState } from 'react';
import { cn, readSetting, writeSetting } from '../../lib/utils';

export type ColumnWidths<K extends string> = Record<K, number>;

/** Which edge of the column the grip sits on. */
export type GripSide = 'right' | 'left';

/**
 * Column widths that the user can drag, remembered per list under `key`.
 * `resize` returns the pointer handlers for a grip; dragging changes that
 * column, a double click restores the default.
 *
 * The side matters. A grip belongs on the edge that actually moves when the
 * column is resized, because that is the line the reader thinks they are
 * holding. For every column but the last that is the right edge: the
 * flexible column beside it gives way. The last column's right edge is the
 * table's own and cannot move, so its grip goes on the left and the drag
 * reads the other way -- pulling that line left widens the column.
 */
export function useColumnWidths<K extends string>(key: string, defaults: ColumnWidths<K>, min = 48) {
  const [widths, setWidths] = useState<ColumnWidths<K>>(() => ({ ...defaults, ...readSetting<Partial<ColumnWidths<K>>>(key, {}) }));

  const resize = useCallback(
    (col: K, side: GripSide = 'right') => ({
      side,
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const start = widths[col];
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        let next = start;
        const towardsWider = side === 'left' ? -1 : 1;
        const move = (ev: PointerEvent) => {
          next = Math.max(min, Math.round(start + towardsWider * (ev.clientX - startX)));
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

/**
 * The drag grip on one edge of a header cell. It is taller than the text so
 * there is something to aim at: the line it draws is the column boundary,
 * and a boundary you cannot hit is not a control.
 *
 * The area lies inside its own cell and the line sits on the edge, rather
 * than the area straddling the edge. Straddling looks the same and is not:
 * the half that reaches into the next cell is only clickable while nothing
 * paints over it, and in a table of sticky header cells the next one does.
 * Measured on the JetStream message table, a grip 16 pixels wide could be
 * hit across six of them, all of them left of the line it draws.
 */
export function ColumnGrip({ side = 'right', ...props }: React.HTMLAttributes<HTMLSpanElement> & { side?: GripSide }) {
  return (
    // Mouse-only affordance; the widths have keyboard-free defaults.
    <span
      aria-hidden
      className={cn(
        'absolute -top-2 -bottom-2 w-5 cursor-col-resize group/grip flex',
        side === 'left' ? 'left-0 justify-start' : 'right-0 justify-end',
      )}
      title="Drag to resize, double-click to reset"
      {...props}
    >
      <span className="w-px h-full bg-line group-hover/grip:bg-accent group-active/grip:bg-accent" />
    </span>
  );
}
