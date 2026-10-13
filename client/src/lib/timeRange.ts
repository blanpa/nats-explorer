import { formatDateTime, formatTime } from './utils';

/** A window of the persistent history, named the way the picker shows it. */
export interface TimeRange {
  from: number;
  to: number;
  /** Short, for the button and the badge: "1 h", "All". */
  label: string;
  /**
   * How the range reads in a sentence. "the last 1 h" works for a preset
   * reaching back from now; "the last All" does not, and neither does "the
   * last 10.9.2026 - 11.9.2026".
   */
  prose: string;
}

/**
 * A window with a start and an end, named the way it reads back: two clock
 * times while it stays inside one day, dates as well once it crosses one.
 * This is what a drag across a chart, the custom form and a link all
 * produce, so all of them are shown, and re-shown, in the same words.
 */
export function windowRange(from: number, to: number): TimeRange {
  const start = Math.max(0, Math.round(from));
  const end = Math.round(to);
  const oneDay = new Date(start).toDateString() === new Date(end).toDateString();
  const at = (ms: number) => (oneDay ? formatTime(ms, false) : formatDateTime(ms));
  const label = `${at(start)} – ${at(end)}`;
  return { from: start, to: end, label, prose: label };
}
