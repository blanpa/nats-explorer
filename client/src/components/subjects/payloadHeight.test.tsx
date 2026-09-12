// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PayloadViewer from './PayloadViewer';

// No decoder rules: the viewer then shows the payload as it arrived.
vi.mock('../../lib/decoders', () => ({
  useDecoders: (sel: (s: { rules: unknown[] }) => unknown) => sel({ rules: [] }),
  findRule: () => undefined,
  decodeWith: async () => ({ ok: false, error: 'not used' }),
}));

const props = { payload: '{"x":1}', type: 'json' as const, size: 7 };
const codeBlock = (c: HTMLElement) => c.querySelector('.code-block') as HTMLElement;
const root = (c: HTMLElement) => c.firstElementChild as HTMLElement;

/**
 * The viewer sits in a column that scrolls. A flex child that is allowed to
 * collapse will: with three charts above it the payload was squeezed to a
 * line, and scrolling down to it found nothing to read.
 */
describe('how tall the payload viewer may be', () => {
  it('keeps its height in a scrolling column', () => {
    const { container } = render(<PayloadViewer {...props} />);
    expect(root(container).className).toContain('shrink-0');
    expect(root(container).className).not.toContain('min-h-0');
    expect(codeBlock(container).className).toContain('min-h-40');
    // Nothing that lets it give way to what is above it.
    expect(codeBlock(container).className).not.toContain('flex-1');
  });

  it('fills a box that was measured for it', () => {
    // A stream row hands the viewer a height; there it may shrink, and it
    // scrolls inside instead.
    const { container } = render(<PayloadViewer {...props} maxHeight={360} />);
    expect(root(container).className).toContain('min-h-0');
    expect(codeBlock(container).className).toContain('flex-1');
    expect(codeBlock(container).style.maxHeight).toBe('360px');
  });
});
