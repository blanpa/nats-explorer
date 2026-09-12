// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import RangePicker, { type TimeRange, windowRange } from './RangePicker';

/**
 * A window dragged out of a chart is rarely the one you wanted to the
 * second, so the picker has to be able to move it: wider, earlier, later,
 * and into a form that shows the numbers.
 */

const MINUTE = 60_000;
const now = new Date('2026-09-10T15:00:00').getTime();

const window10 = (): TimeRange => windowRange(now - 10 * MINUTE, now - 5 * MINUTE);

function picker(range: TimeRange | null) {
  const onChange = vi.fn();
  render(<RangePicker range={range} onChange={onChange} />);
  return onChange;
}

beforeEach(() => {
  vi.setSystemTime(now);
  useStore.setState({ historyDb: true, historyRetention: '' });
});

describe('windowRange', () => {
  it('names a window inside one day by the clock alone', () => {
    const r = windowRange(new Date('2026-09-10T15:47:11').getTime(), new Date('2026-09-10T15:49:03').getTime());
    expect(r.label).toBe('15:47:11 – 15:49:03');
    // The label is also the prose: "in the last 15:47:11 – 15:49:03" would
    // not be a sentence.
    expect(r.prose).toBe(r.label);
  });

  it('says the date as well once the window crosses one', () => {
    const r = windowRange(new Date('2026-09-10T23:50:00').getTime(), new Date('2026-09-11T00:10:00').getTime());
    expect(r.label).toContain('2026');
  });
});

describe('RangePicker', () => {
  it('zooms out around the middle of the window', () => {
    const onChange = picker(window10());
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    const r = onChange.mock.calls[0][0] as TimeRange;
    // Five minutes become ten, half of them added at each end.
    expect(r.to - r.from).toBe(10 * MINUTE);
    expect(r.from).toBe(now - 12.5 * MINUTE);
  });

  it('steps sideways by half a window without changing how wide it is', () => {
    const onChange = picker(window10());
    fireEvent.click(screen.getByRole('button', { name: 'Earlier window' }));
    const r = onChange.mock.calls[0][0] as TimeRange;
    expect(r.to - r.from).toBe(5 * MINUTE);
    expect(r.from).toBe(now - 12.5 * MINUTE);
  });

  it('never steps past now, where a window would be empty', () => {
    const onChange = picker(windowRange(now - 5 * MINUTE, now));
    fireEvent.click(screen.getByRole('button', { name: 'Later window' }));
    const r = onChange.mock.calls[0][0] as TimeRange;
    expect(r.to).toBe(now);
    expect(r.from).toBe(now - 5 * MINUTE);
  });

  it('has nothing to zoom or step while live, or over the whole history', () => {
    const { unmount } = render(<RangePicker range={null} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Zoom out' })).not.toBeInTheDocument();
    unmount();
    // "All" starts at the beginning of the database: there is no window.
    render(<RangePicker range={{ from: 0, to: now, label: 'All', prose: 'the recorded history' }} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Zoom out' })).not.toBeInTheDocument();
  });

  it('names the window on screen without being asked', () => {
    // Dragging across a chart used to leave the row saying "Custom" and
    // nothing else: which stretch of time was on screen could only be found
    // out by opening the form.
    picker(windowRange(new Date('2026-09-10T14:50:07').getTime(), new Date('2026-09-10T14:55:41').getTime()));
    expect(screen.getByText('14:50:07 – 14:55:41')).toBeInTheDocument();
  });

  it('leaves a preset to its own button', () => {
    picker({ from: now - 60 * MINUTE, to: now, label: '1 h', prose: 'the last 1 h' });
    // The highlighted "1 h" says it; a second name would only repeat it.
    expect(screen.getAllByText('1 h')).toHaveLength(1);
  });

  it('opens the custom form on what is on screen, live or preset', () => {
    // Live: the form used to carry the hour before the page was loaded,
    // which on a tab open since the morning is a window from the morning.
    const { unmount } = render(<RangePicker range={null} onChange={vi.fn()} />);
    vi.setSystemTime(now + 120 * MINUTE);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    // A round time loses its seconds on the way into the field; that is
    // the browser's spelling, not our window.
    expect((screen.getByLabelText('Range start') as HTMLInputElement).value).toMatch(/^2026-09-10T16:00/);
    expect((screen.getByLabelText('Range end') as HTMLInputElement).value).toMatch(/^2026-09-10T17:00/);
    unmount();
    vi.setSystemTime(now);

    // A preset hands its own window over, not the default hour.
    render(<RangePicker range={{ from: now - 6 * 60 * MINUTE, to: now, label: '6 h', prose: 'the last 6 h' }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    expect((screen.getByLabelText('Range start') as HTMLInputElement).value).toMatch(/^2026-09-10T09:00/);
  });

  it('opens the custom form on the window that is showing', () => {
    // A window dragged out of a chart lands on odd seconds, and the form
    // has to show them: rounding to the minute on the way in would move
    // the window the reader is about to correct.
    picker(windowRange(new Date('2026-09-10T14:50:07').getTime(), new Date('2026-09-10T14:55:41').getTime()));
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    // Matched loosely at the end: how far a datetime-local field spells its
    // value out past the seconds is the browser's business, not ours.
    expect((screen.getByLabelText('Range start') as HTMLInputElement).value).toMatch(/^2026-09-10T14:50:07/);
    expect((screen.getByLabelText('Range end') as HTMLInputElement).value).toMatch(/^2026-09-10T14:55:41/);
  });

  it('stays out of the way when nothing is written down', () => {
    useStore.setState({ historyDb: false });
    const { container } = render(<RangePicker range={null} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
