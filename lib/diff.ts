/**
 * Minimal text diff for two utf-8 strings. Returns an array of hunks
 * suitable for rendering. Algorithm: classic LCS via dynamic programming
 * over line-level tokens. Works for files up to ~10k lines; above that
 * we degrade to a "too-large, view raw" sentinel.
 *
 * No third-party dep (deliberate — matches the project's zero-dep markdown
 * lexer policy). Output mirrors a much-simplified unified diff: only the
 * line classifications, no @@ headers. The renderer turns it into React.
 */

export type DiffLine =
  | { kind: "equal"; text: string; aLine: number; bLine: number }
  | { kind: "add"; text: string; bLine: number }
  | { kind: "del"; text: string; aLine: number };

export type DiffResult = {
  ok: true;
  lines: DiffLine[];
  added: number;
  deleted: number;
} | {
  ok: false;
  reason: "too_large" | "binary";
};

const MAX_LINES = 10_000;

export function diffLines(a: string, b: string): DiffResult {
  // Heuristic binary check: NUL byte means we treat as binary and skip.
  if (a.indexOf("\0") >= 0 || b.indexOf("\0") >= 0) {
    return { ok: false, reason: "binary" };
  }
  const aLines = a.length === 0 ? [] : a.split(/\r?\n/);
  const bLines = b.length === 0 ? [] : b.split(/\r?\n/);
  if (aLines.length > MAX_LINES || bLines.length > MAX_LINES) {
    return { ok: false, reason: "too_large" };
  }
  const n = aLines.length;
  const m = bLines.length;

  // Memory guard: even within MAX_LINES, the LCS DP matrix is (n+1)*(m+1)
  // Int32 cells. Two 10k-line files would allocate ~400MB synchronously — a
  // server-side OOM lever. Cap the product to ~4M cells (~16MB) and bail.
  if ((n + 1) * (m + 1) > 4_000_000) {
    return { ok: false, reason: "too_large" };
  }

  // LCS lengths matrix
  // Use Int32Array on a flat buffer for memory efficiency on big files.
  const dp = new Int32Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) {
        dp[i * w + j] = dp[(i + 1) * w + (j + 1)] + 1;
      } else {
        const down = dp[(i + 1) * w + j];
        const right = dp[i * w + (j + 1)];
        dp[i * w + j] = down >= right ? down : right;
      }
    }
  }
  const out: DiffLine[] = [];
  let added = 0;
  let deleted = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push({ kind: "equal", text: aLines[i], aLine: i + 1, bLine: j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      out.push({ kind: "del", text: aLines[i], aLine: i + 1 });
      deleted++;
      i++;
    } else {
      out.push({ kind: "add", text: bLines[j], bLine: j + 1 });
      added++;
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: "del", text: aLines[i], aLine: i + 1 });
    deleted++;
    i++;
  }
  while (j < m) {
    out.push({ kind: "add", text: bLines[j], bLine: j + 1 });
    added++;
    j++;
  }
  return { ok: true, lines: out, added, deleted };
}

/** Group contiguous equal lines into context blocks of N lines on either
 *  side of any add/del so the rendering can collapse the boring middle. */
export function collapseContext(
  lines: DiffLine[],
  context = 3,
): Array<DiffLine | { kind: "skip"; count: number }> {
  const changedIdx: number[] = [];
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].kind !== "equal") changedIdx.push(k);
  }
  if (changedIdx.length === 0) return [];

  const keep = new Uint8Array(lines.length);
  for (const c of changedIdx) {
    const lo = Math.max(0, c - context);
    const hi = Math.min(lines.length - 1, c + context);
    for (let k = lo; k <= hi; k++) keep[k] = 1;
  }
  const result: Array<DiffLine | { kind: "skip"; count: number }> = [];
  let skipCount = 0;
  for (let k = 0; k < lines.length; k++) {
    if (keep[k]) {
      if (skipCount > 0) {
        result.push({ kind: "skip", count: skipCount });
        skipCount = 0;
      }
      result.push(lines[k]);
    } else {
      skipCount++;
    }
  }
  if (skipCount > 0) result.push({ kind: "skip", count: skipCount });
  return result;
}
