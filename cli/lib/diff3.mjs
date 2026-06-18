/**
 * diff3.mjs — zero-dependency 3-way line merge.
 *
 * A small, self-contained diff3 implementation for the `desk sync` client so the
 * CLI keeps zero runtime deps. The sync core prefers shelling to `git merge-file`
 * when git is on PATH (battle-tested), and falls back to this when git is absent.
 *
 * Algorithm: classic diff3 over lines.
 *   1. LCS-diff `base` against each of `a` (ours) and `b` (theirs).
 *   2. Walk the two diffs in lockstep, partitioning the files into "chunks":
 *      stable regions (all three agree) and changed regions.
 *   3. A changed region is a CLEAN merge when only one side diverged from base
 *      (take that side), or when both sides made the *identical* change. It is a
 *      CONFLICT when both sides diverged differently.
 *
 * Returns { clean: boolean, merged: string }. On conflict, `merged` carries
 * standard `<<<<<<< / ======= / >>>>>>>` markers (callers that care only sample
 * `clean`); on a clean merge `merged` is the resolved text.
 */

/** Split into lines, preserving a trailing-newline distinction by keeping the
 * empty final element when the text ends with "\n" is NOT what we want for
 * merge granularity, so we split on \n and treat the array as the line list.
 * We re-join with \n and restore a trailing newline if the inputs had one. */
function splitLines(text) {
  if (text === "") return [];
  return text.split("\n");
}

/** Longest-common-subsequence indices between two arrays of strings.
 * Returns an array of [i, j] matched-index pairs in increasing order. */
function lcs(x, y) {
  const n = x.length;
  const m = y.length;
  // DP table of lengths. O(n*m) — fine for sync-sized docs.
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Build the diff3 "matches" structure: for base, the index in `a` and `b` that
 * each base line maps to (or -1 if that base line was deleted on that side).
 */
function mapBase(base, other) {
  // matchOf[baseIndex] = otherIndex (or -1)
  const matchOf = new Array(base.length).fill(-1);
  const pairs = lcs(base, other);
  for (const [bi, oi] of pairs) matchOf[bi] = oi;
  return matchOf;
}

/**
 * Core 3-way merge over line arrays. Produces a list of resolved line-arrays
 * (clean) or throws nothing — conflicts are encoded inline with markers and the
 * overall `clean` flag is returned false.
 */
function diff3Merge(aLines, baseLines, bLines, labelA, labelB) {
  const aOf = mapBase(baseLines, aLines); // base→a
  const bOf = mapBase(baseLines, bLines); // base→b

  const out = [];
  let conflict = false;

  let ai = 0; // cursor into aLines
  let bi = 0; // cursor into bLines
  let ci = 0; // cursor into baseLines

  // Find the next base line that is "stable" — present in BOTH a and b — at or
  // after a given base index, returning its [a-index, b-index].
  function nextStable(from) {
    for (let k = from; k < baseLines.length; k++) {
      if (aOf[k] !== -1 && bOf[k] !== -1) return k;
    }
    return baseLines.length;
  }

  while (ci < baseLines.length || ai < aLines.length || bi < bLines.length) {
    const stable = nextStable(ci);

    // a/b lines emitted before the next stable base line form a changed region.
    const stableA = stable < baseLines.length ? aOf[stable] : aLines.length;
    const stableB = stable < baseLines.length ? bOf[stable] : bLines.length;

    const aChunk = aLines.slice(ai, stableA);
    const bChunk = bLines.slice(bi, stableB);
    const baseChunk = baseLines.slice(ci, stable);

    const aChanged = !arraysEqual(aChunk, baseChunk);
    const bChanged = !arraysEqual(bChunk, baseChunk);

    if (!aChanged && !bChanged) {
      // No change in this region — emit base (== a == b).
      for (const ln of aChunk) out.push(ln);
    } else if (aChanged && !bChanged) {
      for (const ln of aChunk) out.push(ln); // take ours
    } else if (!aChanged && bChanged) {
      for (const ln of bChunk) out.push(ln); // take theirs
    } else if (arraysEqual(aChunk, bChunk)) {
      // Both sides made the identical change — take it once.
      for (const ln of aChunk) out.push(ln);
    } else {
      // True conflict.
      conflict = true;
      out.push(`<<<<<<< ${labelA}`);
      for (const ln of aChunk) out.push(ln);
      out.push("=======");
      for (const ln of bChunk) out.push(ln);
      out.push(`>>>>>>> ${labelB}`);
    }

    if (stable >= baseLines.length) {
      ai = aLines.length;
      bi = bLines.length;
      ci = baseLines.length;
      break;
    }

    // Emit the stable line itself and advance all three cursors past it.
    out.push(baseLines[stable]);
    ai = stableA + 1;
    bi = stableB + 1;
    ci = stable + 1;
  }

  return { clean: !conflict, lines: out };
}

function arraysEqual(x, y) {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * Public API. Merge `a` (ours) and `b` (theirs) against common ancestor `base`.
 *
 * @param {string} a     "ours" — the local content
 * @param {string} base  common ancestor (the last-synced version content)
 * @param {string} b     "theirs" — the cloud HEAD content
 * @param {{labelA?: string, labelB?: string}} [opts]
 * @returns {{clean: boolean, merged: string}}
 */
export function merge3(a, base, b, opts = {}) {
  const labelA = opts.labelA ?? "local";
  const labelB = opts.labelB ?? "cloud";

  // Fast paths.
  if (a === b) return { clean: true, merged: a };
  if (a === base) return { clean: true, merged: b }; // only theirs changed
  if (b === base) return { clean: true, merged: a }; // only ours changed

  const trailing = a.endsWith("\n") || b.endsWith("\n");
  const { clean, lines } = diff3Merge(
    splitLines(a),
    splitLines(base),
    splitLines(b),
    labelA,
    labelB,
  );

  let merged = lines.join("\n");
  if (trailing && merged !== "" && !merged.endsWith("\n")) merged += "\n";
  return { clean, merged };
}
