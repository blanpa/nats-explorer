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
