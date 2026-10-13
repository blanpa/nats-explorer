/**
 * The parts of a consumer form that are text in the dialog and lists on
 * the wire: filters as a comma list, the backoff as seconds per attempt.
 */

/** "1, 5, 30" in seconds becomes nanoseconds per attempt; what is not a positive number is skipped. */
export function parseBackoff(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .map(s => Number(s))
    .filter(n => Number.isFinite(n) && n > 0)
    .map(n => Math.round(n * 1e9));
}

/** Nanoseconds per attempt back to "1, 5, 30". */
export function formatBackoff(backoff: number[] | undefined): string {
  if (!backoff?.length) return '';
  return backoff.map(ns => String(ns / 1e9)).join(', ');
}

/** One filter is `filterSubject`, several are `filterSubjects`; the server wants them apart. */
export function splitFilters(text: string): { filterSubject?: string; filterSubjects?: string[] } {
  const list = text
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (list.length === 0) return {};
  if (list.length === 1) return { filterSubject: list[0] };
  return { filterSubjects: list };
}
