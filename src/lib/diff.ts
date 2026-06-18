/**
 * Minimal dependency-free line diff.
 *
 * Computes a unified line diff between two strings using a classic
 * Longest-Common-Subsequence (LCS) dynamic-programming table over the lines.
 * Lines present in both (in order) are emitted as context (`ctx`); lines only
 * in `a` are deletions (`del`); lines only in `b` are additions (`add`).
 *
 * This is intentionally simple — no hunks, no @@ headers, no fuzz. The doc
 * reader renders the full file with add/del/ctx coloring (see --diff-* tokens),
 * which is all the version-rail diff view needs.
 */

export type DiffLine = {
  type: "ctx" | "add" | "del";
  text: string;
};

/**
 * Split a document into lines for diffing.
 *
 * A trailing newline does NOT produce a spurious empty final line (so
 * "a\nb\n" and "a\nb" diff cleanly against each other at the tail). An empty
 * string is zero lines.
 */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function unifiedDiff(a: string, b: string): DiffLine[] {
  const aLines = splitLines(a);
  const bLines = splitLines(b);
  const n = aLines.length;
  const m = bLines.length;

  // LCS length table. lcs[i][j] = LCS length of aLines[i..] and bLines[j..].
  // (n+1) x (m+1), filled from the bottom-right.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push({ type: "ctx", text: aLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      // Dropping aLines[i] keeps (or ties) the LCS → it's a deletion.
      out.push({ type: "del", text: aLines[i] });
      i++;
    } else {
      out.push({ type: "add", text: bLines[j] });
      j++;
    }
  }

  // Tail: whatever remains is a pure addition or deletion run.
  while (i < n) {
    out.push({ type: "del", text: aLines[i] });
    i++;
  }
  while (j < m) {
    out.push({ type: "add", text: bLines[j] });
    j++;
  }

  return out;
}
