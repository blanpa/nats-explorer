/**
 * Does a subject match a NATS pattern: `*` covers one token, `>` the rest of
 * the subject and at least one token of it.
 *
 * The server answers the same question in `internal/subject`, and the two
 * have to agree -- a subscription the browser calls a match and the server
 * does not is worse than no answer. The rule is small enough to hold twice;
 * `subjectMatch.test.ts` states it in the cases where the two could drift.
 */
export function subjectMatches(pattern: string, subject: string): boolean {
  if (!pattern || !subject) return false;
  const pt = pattern.split('.');
  const st = subject.split('.');
  for (let i = 0; i < pt.length; i++) {
    const p = pt[i];
    if (p === '>') return i === pt.length - 1 && st.length > i;
    if (i >= st.length || (p !== '*' && p !== st[i])) return false;
  }
  return pt.length === st.length;
}

/**
 * Whether one pattern covers everything another one does.
 *
 * Two subscriptions that overlap -- `uns.>` next to `uns.acme.>` -- deliver
 * every message twice: NATS sends one copy per subscription, so the rate
 * doubles, the history counts double, and nothing says why. The narrower
 * pattern adds nothing and is the one to drop.
 *
 * Answered by expansion rather than by cleverness: a `*` in the narrow
 * pattern is covered by a `*` or a `>` in the wide one, and a `>` in the
 * narrow pattern needs a `>` in the wide one at or before it.
 */
export function covers(wide: string, narrow: string): boolean {
  if (wide === narrow) return true;
  const w = wide.split('.');
  const n = narrow.split('.');
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '>') return n.length >= i + 1;
    if (i >= n.length) return false;
    if (n[i] === '>') return false;
    if (w[i] === '*') continue;
    if (w[i] !== n[i]) return false;
  }
  return w.length === n.length && !n.includes('>');
}

/** Pairs of subscriptions where the first covers the second, which is then dead weight. */
export function overlappingPatterns(patterns: string[]): { wide: string; narrow: string }[] {
  const out: { wide: string; narrow: string }[] = [];
  for (const wide of patterns) {
    for (const narrow of patterns) {
      if (wide !== narrow && covers(wide, narrow)) out.push({ wide, narrow });
    }
  }
  return out;
}
