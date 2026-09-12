/**
 * Completing what is being typed into the subject filter.
 *
 * The tree below the box is already the list of matches, so a dropdown
 * would show it twice. What the box cannot do on its own is spare the
 * typing: a UNS subject like `uns.acme.factory-berlin.assembly.line-1` is
 * long, and the segments repeat. So the box completes, shell-style, and
 * the tree stays visible.
 *
 * The filter matches space-separated terms that must all occur in a
 * subject, so only the last term is being written and only it is
 * completed.
 */

/** How far a path completion goes: to the end of the next segment. */
function nextSegmentEnd(subject: string, from: number): number {
  const dot = subject.indexOf('.', from);
  return dot === -1 ? subject.length : dot + 1;
}

/** The candidates the typed text could grow into. */
export function candidatesFor(term: string, subjects: Iterable<string>): string[] {
  const lower = term.toLowerCase();
  if (!lower) return [];
  const out = new Set<string>();
  for (const subject of subjects) {
    if (lower.includes('.')) {
      // A dotted term is a path: grow it by one segment at a time, so a
      // long subject arrives in steps the reader can steer.
      if (subject.toLowerCase().startsWith(lower)) out.add(subject.slice(0, nextSegmentEnd(subject, term.length)));
      continue;
    }
    // A bare term is a segment: every segment that begins with it is a
    // candidate, wherever in the subject it sits.
    for (const segment of subject.split('.')) if (segment.toLowerCase().startsWith(lower)) out.add(segment);
  }
  return [...out];
}

/** The longest start every candidate shares, compared without case. */
function commonPrefix(values: string[]): string {
  if (values.length === 0) return '';
  let prefix = values[0];
  for (const v of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < v.length && prefix[i].toLowerCase() === v[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * What to show faintly behind the cursor: the text the last term would
 * grow into, or empty when there is nothing to add. Never shortens or
 * rewrites what was typed -- a suggestion that changes the letters already
 * on screen is a correction, and this is not one.
 */
export function completionFor(filter: string, subjects: Iterable<string>): string {
  // Only a term at the very end is being written; a trailing space means
  // the reader has moved on to the next one.
  if (!filter || /\s$/.test(filter)) return '';
  const term = filter.slice(filter.lastIndexOf(' ') + 1);
  if (!term) return '';
  const prefix = commonPrefix(candidatesFor(term, subjects));
  return prefix.length > term.length ? prefix.slice(term.length) : '';
}
