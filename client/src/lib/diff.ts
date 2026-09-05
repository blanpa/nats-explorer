export type DiffOp = { type: 'same' | 'add' | 'del'; line: string };

const MAX_LCS_LINES = 600;

/**
 * Line diff based on longest-common-subsequence. Falls back to a positional
 * comparison for very large inputs to keep the UI responsive.
 */
export function diffLines(prev: string, curr: string): DiffOp[] {
  const a = prev.split('\n');
  const b = curr.split('\n');

  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    const out: DiffOp[] = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] === b[i]) out.push({ type: 'same', line: b[i] ?? '' });
      else {
        if (a[i] !== undefined) out.push({ type: 'del', line: a[i] });
        if (b[i] !== undefined) out.push({ type: 'add', line: b[i] });
      }
    }
    return out;
  }

  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', line: a[i] });
      i++;
    } else {
      out.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', line: a[i++] });
  while (j < m) out.push({ type: 'add', line: b[j++] });
  return out;
}
