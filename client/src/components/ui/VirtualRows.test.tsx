// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VirtualRows } from './VirtualRows';

/**
 * The history rail turns "the reader has scrolled back" into "hold the
 * payload on screen". The signal has to be the scroll itself: a short list
 * is at its end the moment it is drawn, so paging -- the obvious other
 * signal -- would fire for every quiet subject before anyone looked at it.
 */
function List({ onScrolledAway, onEndReached }: { onScrolledAway?: (away: boolean) => void; onEndReached?: () => void }) {
  return (
    <VirtualRows
      className="h-40"
      count={500}
      rowHeight={40}
      onScrolledAway={onScrolledAway}
      onEndReached={onEndReached}
      rowKey={i => i}
      renderRow={i => <div data-testid={`row-${i}`}>row {i}</div>}
    />
  );
}

const scroller = (container: HTMLElement) => container.querySelector('.overflow-auto') as HTMLDivElement;

function scrollTo(el: HTMLDivElement, top: number) {
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true });
  fireEvent.scroll(el);
}

describe('VirtualRows', () => {
  it('reports leaving the first rows behind, and coming back', () => {
    const onScrolledAway = vi.fn();
    const { container } = render(<List onScrolledAway={onScrolledAway} />);
    const el = scroller(container);

    // A nudge is not "scrolled back": two rows of slack before it counts.
    scrollTo(el, 50);
    expect(onScrolledAway).not.toHaveBeenCalled();

    scrollTo(el, 400);
    expect(onScrolledAway).toHaveBeenCalledWith(true);

    // Once per crossing, not once per scroll event.
    scrollTo(el, 800);
    expect(onScrolledAway).toHaveBeenCalledTimes(1);

    scrollTo(el, 0);
    expect(onScrolledAway).toHaveBeenLastCalledWith(false);
    expect(onScrolledAway).toHaveBeenCalledTimes(2);
  });

  it('says nothing when no one is listening', () => {
    const { container } = render(<List />);
    // No handler, no scroll listener: the rest of the app pays nothing.
    expect(scroller(container).onscroll).toBeFalsy();
  });
});
