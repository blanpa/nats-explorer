// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import type { NatsMessage } from 'shared';
import { describe, expect, it, vi } from 'vitest';
import ValueChart from './ValueChart';

const msg = (t: number, temp: number): NatsMessage => ({
  subject: 'plant.temp',
  payload: JSON.stringify({ temp }),
  payloadType: 'json',
  timestamp: t,
  size: 20,
  sequence: t,
});

const messages = [msg(1000, 20), msg(2000, 30), msg(3000, 25)];
const chartOf = (container: HTMLElement) => container.querySelector('svg')!;

describe('ValueChart', () => {
  it('marks the message that is on screen', () => {
    const { container, rerender } = render(<ValueChart messages={messages} fieldPath="temp" marker={{ t: 2000, v: 30 }} />);
    // The marker adds a vertical line and a filled dot on top of the line chart.
    const marks = container.querySelectorAll('circle[r="5"]');
    expect(marks).toHaveLength(1);
    // Its value heads the chart instead of the newest point (25).
    expect(container.querySelector('.font-mono.text-md')?.textContent).toBe('30');

    // A marker outside the window is not drawn.
    rerender(<ValueChart messages={messages} fieldPath="temp" marker={{ t: 999_999, v: 30 }} />);
    expect(container.querySelectorAll('circle[r="5"]')).toHaveLength(0);
  });

  it('reports the clicked point', () => {
    const onPick = vi.fn();
    const { container } = render(<ValueChart messages={messages} fieldPath="temp" onPick={onPick} />);
    const svg = chartOf(container);
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 160, right: 400, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    // Far right of the plot area is the newest point; the chart lays itself
    // out at its default width because jsdom has no ResizeObserver.
    fireEvent.click(svg, { clientX: 590 });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toMatchObject({ t: 3000, v: 25 });
  });

  it('says nothing about clicking when there is no handler', () => {
    render(<ValueChart messages={messages} fieldPath="temp" />);
    expect(screen.queryByText(/click a point/)).toBeNull();
  });
});
