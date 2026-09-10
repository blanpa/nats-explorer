// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { NatsMessage } from 'shared';
import { describe, expect, it, vi } from 'vitest';
import TrendStrip from './TrendStrip';

const msg = (payload: string, i: number): NatsMessage => ({
  subject: 'plant.temp',
  payload,
  payloadType: 'json',
  timestamp: i,
  size: payload.length,
  sequence: i,
});

describe('TrendStrip', () => {
  it('shows a sparkline per numeric field of the latest message', () => {
    const messages = [21, 22, 23, 24].map((t, i) => msg(JSON.stringify({ temp: t, humidity: 40 + i, unit: 'C', nested: { x: 1 } }), i));
    const onSelect = vi.fn();
    render(<TrendStrip messages={messages} latest={messages[3]} selected={['temp']} onSelect={onSelect} />);
    // A charted field offers to stop rather than to start.
    expect(screen.getByTitle('Stop charting temp')).toHaveTextContent('24');
    expect(screen.getByTitle('Chart humidity')).toHaveTextContent('43');
    expect(screen.queryByTitle('Chart unit')).toBeNull();
    expect(screen.queryByTitle('Chart nested')).toBeNull();
    fireEvent.click(screen.getByTitle('Chart humidity'));
    expect(onSelect).toHaveBeenCalledWith('humidity');
  });

  it('renders nothing for too little history or non-JSON payloads', () => {
    const two = [1, 2].map((t, i) => msg(JSON.stringify({ temp: t }), i));
    const { container, rerender } = render(<TrendStrip messages={two} latest={two[1]} selected={[]} onSelect={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
    const text: NatsMessage = { ...two[1], payload: 'hello', payloadType: 'string' };
    rerender(<TrendStrip messages={[...two, text]} latest={text} selected={[]} onSelect={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
