/**
 * Pure, client-safe view-model helpers for the docs surfaces.
 *
 * This module imports NOTHING that pulls the DB layer (`@/lib/docs`) — only
 * `@/lib/path` (pure) and `@/lib/snippet-delim` (two constants). That keeps it
 * importable from client components (DocsTree, PathPicker) without dragging the
 * `postgres` driver into the browser bundle. The version-rail helpers that
 * reference DB types live in `view-model.ts`, which re-exports everything here
 * for back-compat.
 */

import { normalizePath } from "@/lib/path";
import { SNIPPET_START, SNIPPET_STOP } from "@/lib/snippet-delim";

// ── Stamps (client-safe) ─────────────────────────────────────────────────────

/** Short content-hash stamp shown next to a doc (first 7 chars, like git). */
export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

/**
 * YYYY-MM-DD stamp in UTC — stable across server/client, no locale drift.
 *
 * Accepts a Date or a date-ish string: drizzle maps typed columns to Date, but
 * raw `sql<Date>` aggregates (e.g. `max(published_at)`) come back as strings at
 * runtime, so we coerce defensively.
 */
export function dateStamp(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

// ── Search snippet rendering ─────────────────────────────────────────────────

/**
 * One run of snippet text: either plain (`match:false`) or a highlighted match
 * (`match:true`, drawn as <mark> in the UI). Pure data — the renderer maps it
 * to React text + <mark> nodes, which React escapes, so any raw `<…>` in the
 * underlying document content is rendered as inert text (never HTML).
 */
export type SnippetRun = { text: string; match: boolean };

/**
 * Split a delimiter-encoded search snippet (from `searchDocs`, marked with
 * SNIPPET_START / SNIPPET_STOP control chars around matched terms) into an
 * ordered list of plain / match runs.
 *
 * This NEVER interprets the snippet as HTML. The delimiters are control
 * characters, not markup; the surrounding text — including anything that looks
 * like an HTML tag from the doc body — is returned as plain `text` for the
 * caller to render through an escaping sink. Empty runs are dropped.
 */
export function splitSnippet(snippet: string): SnippetRun[] {
  if (!snippet) return [];
  const runs: SnippetRun[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const start = rest.indexOf(SNIPPET_START);
    if (start === -1) {
      runs.push({ text: rest, match: false });
      break;
    }
    if (start > 0) runs.push({ text: rest.slice(0, start), match: false });
    const after = rest.slice(start + SNIPPET_START.length);
    const stop = after.indexOf(SNIPPET_STOP);
    if (stop === -1) {
      // Unbalanced (shouldn't happen) — treat the remainder as a match so no
      // text is lost, and stop.
      runs.push({ text: after, match: true });
      break;
    }
    const matched = after.slice(0, stop);
    if (matched.length > 0) runs.push({ text: matched, match: true });
    rest = after.slice(stop + SNIPPET_STOP.length);
  }
  return runs.filter((r) => r.text.length > 0);
}

/**
 * Render a delimiter-encoded snippet as plain markdown-ish text for non-UI
 * channels (MCP): matched spans wrapped in `**…**`, plain text passed through.
 * The doc body is data, so this is plain text — never an HTML sink.
 */
export function snippetToMarkdown(snippet: string): string {
  return splitSnippet(snippet)
    .map((r) => (r.match ? `**${r.text}**` : r.text))
    .join("");
}

// ── Folder grouping (legacy flat group-by-path) ──────────────────────────────

/**
 * One folder group in the docs list: a path and the docs that live directly at
 * it. KEPT for back-compat (the round-1 flat grouping); the round-2 surface uses
 * `buildDocTree`. Root ('') sorts first; the rest are alphabetical.
 */
export type DocPathGroup<T extends { path: string }> = {
  path: string;
  label: string;
  docs: T[];
};

/**
 * Group docs by their full `path`, root first then alphabetical. Pure — sorts a
 * copy, never mutates the input.
 */
export function groupDocsByPath<T extends { path: string }>(
  docs: T[],
): DocPathGroup<T>[] {
  const byPath = new Map<string, T[]>();
  for (const d of docs) {
    const arr = byPath.get(d.path);
    if (arr) arr.push(d);
    else byPath.set(d.path, [d]);
  }
  const paths = [...byPath.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === "") return -1; // root first
    if (b === "") return 1;
    return a < b ? -1 : 1;
  });
  return paths.map((path) => ({
    path,
    label: path === "" ? "Root" : path,
    docs: byPath.get(path)!,
  }));
}

// ── Folder tree (round-2 collapsible tree) ───────────────────────────────────

/** A folder header row in the rendered tree. */
export type TreeFolderRow = {
  kind: "folder";
  /** Full folder path, e.g. "ops/runbooks" — the collapse key. */
  path: string;
  /** Last segment only, e.g. "runbooks" (rendered as "runbooks/"). */
  name: string;
  /** Recursive doc count under this folder (self + descendants). */
  count: number;
  /** Nesting depth (0 = top-level folder). Drives indentation. */
  depth: number;
  /** Whether this folder is currently collapsed. */
  collapsed: boolean;
};

/** A doc row in the rendered tree, carrying the underlying doc for rendering. */
export type TreeDocRow<T extends { path: string; slug: string }> = {
  kind: "doc";
  doc: T;
  /** Nesting depth (root docs = 0, docs in a folder = folder.depth + 1). */
  depth: number;
  /** True in search mode: render the matched-path context prefix. */
  showPath: boolean;
  /** The path-context prefix, e.g. "finance/" or "(root)". Only used when showPath. */
  pathContext: string;
};

export type TreeRow<T extends { path: string; slug: string }> =
  | TreeFolderRow
  | TreeDocRow<T>;

/**
 * Derive the set of all folder paths implied by the docs. A folder "exists"
 * exactly when some doc carries it as a (non-empty) prefix segment — there are
 * no folder entities. "ops/runbooks" implies both "ops" and "ops/runbooks".
 * Returned sorted lexicographically.
 */
export function deriveFolders<T extends { path: string }>(docs: T[]): string[] {
  const set = new Set<string>();
  for (const d of docs) {
    if (!d.path) continue;
    const parts = d.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      set.add(parts.slice(0, i).join("/"));
    }
  }
  return [...set].sort();
}

/**
 * Build the flattened, depth-indented tree of folder + doc rows from a doc list.
 * Pure — never mutates the input.
 *
 * Structure (matches the design mock's `walk`):
 *   - Folders render depth-first; within a folder, CHILD FOLDERS first, then the
 *     docs that live directly in that folder.
 *   - A collapsed folder still emits its own header row, but none of its
 *     descendants (folders or docs).
 *   - Root docs (path === '') render LAST, after every folder subtree, at depth 0.
 *   - A folder's `count` is its recursive doc total (self + all descendants),
 *     shown regardless of collapse state.
 *
 * `collapsed` maps a folder path → true when collapsed (absent/false = open).
 */
export function buildDocTree<T extends { path: string; slug: string }>(
  docs: T[],
  collapsed: Record<string, boolean> = {},
): TreeRow<T>[] {
  const folders = deriveFolders(docs);
  const rows: TreeRow<T>[] = [];

  const recursiveCount = (folder: string): number =>
    docs.filter((d) => d.path === folder || d.path.startsWith(folder + "/")).length;

  const walk = (folder: string, depth: number) => {
    const isCollapsed = !!collapsed[folder];
    rows.push({
      kind: "folder",
      path: folder,
      name: folder.split("/").pop()!,
      count: recursiveCount(folder),
      depth,
      collapsed: isCollapsed,
    });
    if (isCollapsed) return;
    // child folders: one segment deeper, same prefix
    const childFolders = folders.filter(
      (f) =>
        f.startsWith(folder + "/") &&
        f.split("/").length === folder.split("/").length + 1,
    );
    for (const cf of childFolders) walk(cf, depth + 1);
    // docs living directly at this folder
    for (const d of docs.filter((d) => d.path === folder)) {
      rows.push({ kind: "doc", doc: d, depth: depth + 1, showPath: false, pathContext: "" });
    }
  };

  // top-level folders (no slash)
  for (const top of folders.filter((f) => !f.includes("/"))) walk(top, 0);
  // root docs last, at depth 0
  for (const d of docs.filter((d) => !d.path)) {
    rows.push({ kind: "doc", doc: d, depth: 0, showPath: false, pathContext: "" });
  }

  return rows;
}

/** Display prefix for a doc's folder in search results: "finance/" or "(root)". */
export function pathContextLabel(path: string): string {
  return path ? path + "/" : "(root)";
}

/**
 * Flatten the tree for a search query: every matching doc as a flat doc row at
 * depth 0, with its folder path shown as a green mono prefix. Matching is a
 * case-insensitive substring over title + slug + path (mirrors the mock).
 *
 * The page may also pass already-server-filtered docs (Postgres FTS over full
 * text); in that case pass `prefiltered: true` so we keep every doc and only add
 * the path context — we never want to drop an FTS hit just because the substring
 * test misses the body match.
 */
export function flattenSearch<T extends { path: string; slug: string; title: string }>(
  docs: T[],
  query: string,
  opts: { prefiltered?: boolean } = {},
): TreeDocRow<T>[] {
  const q = query.trim().toLowerCase();
  const matches = opts.prefiltered
    ? docs
    : docs.filter((d) => (d.title + " " + d.slug + " " + d.path).toLowerCase().includes(q));
  return matches.map((d) => ({
    kind: "doc" as const,
    doc: d,
    depth: 0,
    showPath: true,
    pathContext: pathContextLabel(d.path),
  }));
}

// ── Path picker (Move dialog + Upload folder field) ──────────────────────────

/** One suggestion row in the path picker dropdown. */
export type PathSuggestion = {
  /** What the picker writes into the input when chosen ('' = root). */
  value: string;
  /** Display label: "(root)" or "finance/". */
  label: string;
  /** Right-aligned hint: "selected", "existing folder", "new folder — created on move", "top level". */
  note: string;
  /** True for the synthetic "new folder" row (no such folder exists yet). */
  isNew: boolean;
  /** True when this suggestion equals the currently typed/selected path. */
  selected: boolean;
};

/**
 * Build the autocomplete suggestion list for the path picker. Mirrors the mock:
 *   - always a "(root)" row first;
 *   - existing folders that match the typed substring (capped at `limit`, default 6);
 *   - a trailing "new folder — created on move" row when the typed path is valid,
 *     non-empty, and is NOT already an existing folder.
 *
 * `existingFolders` is the derived folder list (deriveFolders over ALL docs, so
 * a move can target any folder, not just visible ones). `typed` is the raw input.
 */
export function pathSuggestions(
  typed: string,
  existingFolders: string[],
  limit = 6,
): PathSuggestion[] {
  const norm = normalizePath(typed); // null when the typed path is invalid
  const tq = (norm ?? "").toLowerCase();
  const out: PathSuggestion[] = [];

  out.push({
    value: "",
    label: "(root)",
    note: norm === "" ? "selected" : "top level",
    isNew: false,
    selected: norm === "",
  });

  const matched = existingFolders.filter((f) => !tq || f.toLowerCase().includes(tq));
  for (const f of matched.slice(0, limit)) {
    const selected = norm === f;
    out.push({
      value: f,
      label: f + "/",
      note: selected ? "selected" : "existing folder",
      isNew: false,
      selected,
    });
  }

  // New-folder row: typed path is valid, non-empty, and not an existing folder.
  if (norm && norm.length > 0 && !existingFolders.includes(norm)) {
    out.push({
      value: norm,
      label: norm + "/",
      note: "new folder — created on move",
      isNew: true,
      selected: false,
    });
  }

  return out;
}

/** CTA label for the Move dialog: switches to "Create folder & move" for a new path. */
export function moveCtaLabel(typed: string, existingFolders: string[]): string {
  const norm = normalizePath(typed);
  const isNew = !!norm && norm.length > 0 && !existingFolders.includes(norm);
  return isNew ? "Create folder & move" : "Move";
}

// ── Share-link mode chip (live vs pinned) ────────────────────────────────────

export type ShareModeChip =
  | { kind: "live"; title: string }
  | { kind: "pinned"; label: string; title: string };

/**
 * Map a per-doc share row's pinned state to its mode chip.
 *   - live  → borderless quiet "live" chip (pinnedVersionId === null);
 *   - pinned → purple-family "pinned vN" chip (a FACT, not a success — so it does
 *     NOT use the green ref family). The vN label comes from `versionLabelById`,
 *     which maps a version id to "vN" (derived from the version rail). A pin whose
 *     version is no longer in the map falls back to a bare "pinned".
 */
export function shareModeChip(
  pinnedVersionId: number | null,
  versionLabelById: Record<number, string>,
): ShareModeChip {
  if (pinnedVersionId === null) {
    return { kind: "live", title: "Follows future edits — always the latest published version" };
  }
  const v = versionLabelById[pinnedVersionId];
  return {
    kind: "pinned",
    label: v ? `pinned ${v}` : "pinned",
    title: "Stays at this snapshot even as the doc evolves",
  };
}

/** Extract the bare "vN" from a rail label like "v5 · current" → "v5". */
export function railVersionShort(label: string): string {
  const m = label.match(/^v\d+/);
  return m ? m[0] : label;
}
