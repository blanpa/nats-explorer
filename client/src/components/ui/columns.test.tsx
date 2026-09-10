// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ColumnGrip, useColumnWidths } from './columns';

/**
 * A grip belongs on the edge that moves. For the last column of a table
 * that is its left edge, and pulling it left has to widen the column --
 * dragging one way while the boundary goes the other is what "the size
 * column does not resize properly" feels like.
 */
function Table() {
  const { widths, resize } = useColumnWidths('test.cols', { time: 100, size: 60 });
  return (
    <div>
      <span data-testid="widths">{`${widths.time}/${widths.size}`}</span>
      <span className="relative">
        Time
        <ColumnGrip data-testid="grip-time" {...resize('time')} />
      </span>
      <span className="relative">
        Size
        <ColumnGrip data-testid="grip-size" {...resize('size', 'left')} />
      </span>
    </div>
  );
}

/** One drag, as the pointer events the grip listens for. */
function drag(testId: string, dx: number) {
  const grip = screen.getByTestId(testId);
  grip.setPointerCapture = () => undefined;
  fireEvent.pointerDown(grip, { clientX: 500, pointerId: 1 });
  fireEvent(grip, new PointerEvent('pointermove', { clientX: 500 + dx, pointerId: 1, bubbles: true }));
  fireEvent(grip, new PointerEvent('pointerup', { clientX: 500 + dx, pointerId: 1, bubbles: true }));
}

const widths = () => screen.getByTestId('widths').textContent;

beforeEach(() => localStorage.clear());

describe('column widths', () => {
  it('widens a middle column when its right edge is pulled right', () => {
    render(<Table />);
    drag('grip-time', 40);
    expect(widths()).toBe('140/60');
  });

  it('widens the last column when its left edge is pulled left', () => {
    render(<Table />);
    drag('grip-size', -40);
    expect(widths()).toBe('100/100');
  });

  it('narrows the last column when that edge goes right', () => {
    render(<Table />);
    drag('grip-size', 10);
    expect(widths()).toBe('100/50');
  });

  it('stops at a width that can still be grabbed', () => {
    render(<Table />);
    drag('grip-size', 500);
    expect(widths()).toBe('100/48');
  });

  it('remembers a width and restores the default on a double click', () => {
    const { unmount } = render(<Table />);
    drag('grip-time', 40);
    unmount();
    render(<Table />);
    expect(widths()).toBe('140/60');
    fireEvent.doubleClick(screen.getByTestId('grip-time'));
    expect(widths()).toBe('100/60');
  });

  it('puts the grip on the side it was asked for', () => {
    render(<Table />);
    expect(screen.getByTestId('grip-time').className).toContain('-right-2');
    expect(screen.getByTestId('grip-size').className).toContain('-left-3');
  });
});
