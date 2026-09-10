// @vitest-environment jsdom
import { fireEvent, render } from '@testing-library/react';
import type { HistorySeries, NatsMessage } from 'shared';
import { describe, expect, it, vi } from 'vitest';
import ValueChart, { type ChartSeries, colorForIndex, mergePoints } from './ValueChart';

const msg = (t: number, temp: number): NatsMessage => ({
  subject: 'plant.temp',
  payload: JSON.stringify({ temp }),
  payloadType: 'json',
  timestamp: t,
  size: 20,
  sequence: t,
});

const messages = [msg(1000, 20), msg(2000, 30), msg(3000, 25)];
const temp: ChartSeries = { field: 'temp', color: colorForIndex(0), points: mergePoints(null, messages, 'temp') };
const rpm: ChartSeries = {
  field: 'rpm',
  color: colorForIndex(1),
  points: [
    { t: 1000, v: 8000 },
    { t: 2000, v: 8200 },
    { t: 3000, v: 8100 },
  ],
};
const chartOf = (container: HTMLElement) => container.querySelector('svg')!;
const values = (container: HTMLElement) => [...container.querySelectorAll('.font-semibold')].map(e => e.textContent);

describe('ValueChart', () => {
  it('marks the message that is on screen', () => {
    const { container, rerender } = render(<ValueChart series={[temp]} type="line" marker={{ t: 2000, v: 30 }} />);
    // The marker adds a vertical line and a filled dot on top of the line chart.
    expect(container.querySelectorAll('circle[r="5"]')).toHaveLength(1);
    // Its value heads the chart instead of the newest point (25).
    expect(values(container)).toEqual(['30']);

    // A marker outside the window is not drawn.
    rerender(<ValueChart series={[temp]} type="line" marker={{ t: 999_999, v: 30 }} />);
    expect(container.querySelectorAll('circle[r="5"]')).toHaveLength(0);
  });

  it('reports the clicked point and which field it belongs to', () => {
    const onPick = vi.fn();
    const { container } = render(<ValueChart series={[temp]} type="line" onPick={onPick} />);
    const svg = chartOf(container);
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 160, right: 400, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    // Far right of the plot area is the newest point; the chart lays itself
    // out at its default width because jsdom has no ResizeObserver.
    fireEvent.click(svg, { clientX: 590 });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toMatchObject({ t: 3000, v: 25 });
    expect(onPick.mock.calls[0][1]).toBe('temp');
  });

  it('hands back the stretch of time that was dragged over', () => {
    const onZoom = vi.fn();
    const onPick = vi.fn();
    const { container } = render(<ValueChart series={[temp]} type="line" onPick={onPick} onZoom={onZoom} />);
    const svg = chartOf(container);
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 160, right: 600, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    svg.setPointerCapture = () => undefined;

    // The plot runs from x=56 to x=586 over 1000..3000ms, so the middle
    // third of it is roughly the second half of the second second.
    fireEvent.pointerDown(svg, { clientX: 240, pointerId: 1, button: 0 });
    fireEvent.pointerMove(svg, { clientX: 420, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 420, pointerId: 1 });

    expect(onZoom).toHaveBeenCalledTimes(1);
    const [from, to] = onZoom.mock.calls[0];
    expect(from).toBeGreaterThan(1000);
    expect(to).toBeLessThan(3000);
    expect(to - from).toBeGreaterThan(0);
    // The click that ends a drag belongs to the drag, not to a point.
    fireEvent.click(svg, { clientX: 420 });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('treats a drag too short to mean a window as a click', () => {
    const onZoom = vi.fn();
    const onPick = vi.fn();
    const { container } = render(<ValueChart series={[temp]} type="line" onPick={onPick} onZoom={onZoom} />);
    const svg = chartOf(container);
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 160, right: 600, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
    svg.setPointerCapture = () => undefined;

    fireEvent.pointerDown(svg, { clientX: 590, pointerId: 1, button: 0 });
    fireEvent.pointerMove(svg, { clientX: 592, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 592, pointerId: 1 });
    expect(onZoom).not.toHaveBeenCalled();

    fireEvent.click(svg, { clientX: 590 });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('offers no crosshair where there is no window to choose', () => {
    // Without a range to set, a chart is not a picker and must not look
    // like one.
    const { container } = render(<ValueChart series={[temp]} type="line" onPick={() => {}} />);
    expect(chartOf(container).getAttribute('class')).not.toContain('crosshair');
  });

  it('draws every series with its own colour and names them all', () => {
    const { container } = render(<ValueChart series={[temp, rpm]} type="line" />);
    const paths = [...container.querySelectorAll('path')].map(p => p.getAttribute('stroke'));
    expect(paths).toEqual([temp.color, rpm.color]);
    expect(container.textContent).toContain('temp');
    expect(container.textContent).toContain('rpm');
    // Both current values are shown, each next to its field.
    expect(values(container)).toEqual(['25', '8,100']);
  });

  it('keeps the real values in the header when the axis is normalized', () => {
    const { container } = render(<ValueChart series={[temp, rpm]} type="line" normalize />);
    // An axis in per cent is meaningless as a number, so it says so; the
    // values above it stay the ones the messages carried.
    expect(container.textContent).toContain('%');
    expect(values(container)).toEqual(['25', '8,100']);
    expect(container.textContent).toContain('scaled per field');
  });

  it('falls back to lines when bars are asked for with several series', () => {
    const { container } = render(<ValueChart series={[temp, rpm]} type="bars" />);
    expect(container.querySelectorAll('rect')).toHaveLength(0);
    expect(container.querySelectorAll('path')).toHaveLength(2);
  });

  it('says when everything falls on one instant instead of drawing a hairline', () => {
    // Three messages inside one minute reduce to one bucket over a long
    // range; drawn over a time span of zero they are a column of no width
    // against the left edge, which reads as an empty chart.
    const oneMoment: ChartSeries = {
      field: 'n',
      color: colorForIndex(0),
      points: [
        { t: 5000, v: 0 },
        { t: 5000, v: 2 },
      ],
    };
    const { container } = render(<ValueChart series={[oneMoment]} type="line" />);
    expect(container.textContent).toContain('one instant');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('says what it is still waiting for', () => {
    const { container } = render(<ValueChart series={[{ ...temp, points: [{ t: 1, v: 1 }] }]} type="line" />);
    expect(container.textContent).toContain('Collecting data points');
    expect(container.textContent).toContain('1/2');
  });
});

describe('mergePoints', () => {
  const series = (agg: HistorySeries['agg']): HistorySeries => ({
    subject: 'plant.temp',
    field: 'temp',
    points: [[1000, 20]],
    samples: 1,
    last: 1000,
    agg,
  });

  it('appends live messages the series does not cover yet', () => {
    const out = mergePoints(series('minmax'), messages, 'temp', 'minmax');
    // The point at 1000 comes from the series; 2000 and 3000 are live.
    expect(out.map(p => p.t)).toEqual([1000, 2000, 3000]);
  });

  it('appends by the clock, not by the sequence number', () => {
    // Sequences restart at one with every reconnect. A series whose last
    // message was numbered 16 624 used to swallow every live message until
    // the new run's count caught up -- which it never does.
    const afterRestart = { ...series('minmax'), points: [[1000, 20]] as [number, number][], last: 16_624 };
    const live = [msg(2000, 30), msg(3000, 25)];
    expect(mergePoints(afterRestart, live, 'temp', 'minmax').map(p => p.t)).toEqual([1000, 2000, 3000]);
  });

  it('appends everything when the server had nothing to say', () => {
    // A subject the server could not answer for still has messages in the
    // browser; they are the whole chart.
    const empty = { ...series('minmax'), points: [] as [number, number][], last: 0 };
    expect(mergePoints(empty, messages, 'temp', 'minmax').map(p => p.t)).toEqual([1000, 2000, 3000]);
  });

  it('leaves a reduced series alone', () => {
    // An average or a count is a reduction; putting one raw message next to
    // it would make the last bucket jump.
    for (const agg of ['avg', 'sum', 'count', 'rate', 'min', 'max'] as const) {
      expect(mergePoints(series(agg), messages, 'temp', agg).map(p => p.t)).toEqual([1000]);
    }
  });

  it('uses the messages alone when there is no series yet', () => {
    expect(mergePoints(null, messages, 'temp', 'avg').map(p => p.t)).toEqual([1000, 2000, 3000]);
  });
});
