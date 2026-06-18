/**
 * desk-sync.mjs — the `desk sync` subcommand (I/O shell around sync-core).
 *
 * Zero runtime deps: node:crypto, node:fs, node:os, node:path, node:child_process,
 * global fetch. The pure decision engine lives in cli/lib/sync-core.mjs; the
 * merge primitive in cli/lib/diff3.mjs (with a `git merge-file` fast path).
 *
 * Manifest: ~/.config/desk/sync.json (override DESK_SYNC_MANIFEST for tests).
 *   { hubUrl, entries: [
 *       { kind:"file", slug, localPath, lastSyncedVersionId, lastSyncedHash },
 *       { kind:"dir", cloudPathPrefix, localDir, audience,
 *         files: { <slug>: { localPath, lastSyncedVersionId, lastSyncedHash } } }
 *   ] }
 *
 * Commands:
 *   desk sync link <slug> <localPath>
 *   desk sync link-dir <cloudPrefix> <localDir> [--audience <a>]
 *   desk sync unlink <slug|prefix>
 *   desk sync status [--json]
 *   desk sync               (one shot, all entries)  [--dry-run] [--json]
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  renameSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { resolve, dirname, join, basename, extname } from "node:path";
import { spawnSync } from "node:child_process";

import { decideFile, decideDirAdoptions } from "./lib/sync-core.mjs";
import { merge3 } from "./lib/diff3.mjs";

// ── small utils ──────────────────────────────────────────────────────────────

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");

function manifestPath() {
  if (process.env.DESK_SYNC_MANIFEST) return process.env.DESK_SYNC_MANIFEST;
  const base =
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "desk", "sync.json");
}

function loadManifest() {
  const p = manifestPath();
  if (!existsSync(p)) return { hubUrl: null, entries: [] };
  try {
    const raw = readFileSync(p, "utf8");
    const m = JSON.parse(raw);
    if (!Array.isArray(m.entries)) m.entries = [];
    return m;
  } catch {
    // Corrupt manifest — per spec, the safe move is to treat all as
    // both-changed, but a JSON-level corruption means we can't read entries at
    // all. Start fresh rather than crash; the user re-links.
    return { hubUrl: null, entries: [], _corrupt: true };
  }
}

function saveManifest(m) {
  const p = manifestPath();
  mkdirSync(dirname(p), { recursive: true });
  atomicWrite(p, JSON.stringify(m, null, 2) + "\n");
}

/** tmp + rename atomic write (same dir so rename is atomic on one fs). */
function atomicWrite(target, content) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);
}

function readLocal(absPath) {
  try {
    if (!statSync(absPath).isFile()) return null;
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function formatFromExt(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".md") return "md";
  if (ext === ".html" || ext === ".htm") return "html";
  return null;
}

function slugify(stem) {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractMdTitle(content) {
  const m = content.match(/^#[ \t]+(.+)$/m);
  return m ? m[1].trim() : null;
}

// ── git merge-file fast path, diff3 fallback ─────────────────────────────────

let _gitAvailable = null;
function gitAvailable() {
  if (_gitAvailable !== null) return _gitAvailable;
  const r = spawnSync("git", ["--version"], { encoding: "utf8" });
  _gitAvailable = r.status === 0;
  return _gitAvailable;
}

/**
 * 3-way merge. Prefers `git merge-file -p` (writes nothing; prints to stdout,
 * exit status = conflict count) when git is present; otherwise the bundled JS
 * diff3. Returns {clean, merged}.
 */
function merge3way(ours, base, theirs, { labelA = "local", labelB = "cloud" } = {}) {
  if (gitAvailable()) {
    const dir = join(
      process.env.TMPDIR ?? "/tmp",
      `desk-merge-${process.pid}-${Date.now()}`,
    );
    mkdirSync(dir, { recursive: true });
    const fO = join(dir, "ours");
    const fB = join(dir, "base");
    const fT = join(dir, "theirs");
    try {
      writeFileSync(fO, ours);
      writeFileSync(fB, base);
      writeFileSync(fT, theirs);
      const r = spawnSync(
        "git",
        ["merge-file", "-p", `-L`, labelA, `-L`, "base", `-L`, labelB, fO, fB, fT],
        { encoding: "utf8" },
      );
      // git merge-file: exit 0 = clean, >0 = #conflicts, <0 = error.
      if (r.status !== null && r.status >= 0) {
        return { clean: r.status === 0, merged: r.stdout };
      }
      // error → fall through to JS
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  return merge3(ours, base, theirs, { labelA, labelB });
}

// ── HTTP layer (mirrors desk.mjs auth) ───────────────────────────────────────

function hubUrl(manifest) {
  return manifest.hubUrl ?? process.env.HUB_URL ?? "http://localhost:3000";
}

function authHeaders() {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret) {
    return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
  }
  return { "x-dev-role": process.env.HUB_DEV_ROLE ?? "admin" };
}

/** True when this client is acting as a member (pushes → always revisions). */
function isMemberToken() {
  // Dev: explicit HUB_DEV_ROLE=member. Prod: a member CF token would be
  // configured here; absent a distinguishing signal we treat CF tokens as staff
  // and rely on the server's 403 to surface a real member's lack of publish.
  return (process.env.HUB_DEV_ROLE ?? "admin") === "member";
}

async function api(manifest, path, options = {}) {
  const url = `${hubUrl(manifest)}${path}`;
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(options.headers ?? {}),
      },
    });
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      throw new ApiError(0, `Connection refused — is the hub running? (${url})`);
    }
    throw new ApiError(0, `Network error: ${msg}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`, body);
  }
  return body;
}

class ApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Fetch the remote doc into the shape sync-core expects, or null if gone. */
async function fetchRemoteDoc(manifest, slug) {
  let json;
  try {
    json = await api(manifest, `/api/docs/${encodeURIComponent(slug)}`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  const cur = json.currentVersion;
  if (!json.doc || json.doc.unpublishedAt || !cur) {
    return null;
  }
  return {
    currentVersionId: cur.id,
    content: cur.content,
    contentHash: cur.contentHash,
    format: json.doc.format,
    audience: json.doc.audience,
    path: json.doc.path,
  };
}

/** Base-content fetcher for a given version id (the per-version REST route). */
function makeBaseFetcher(manifest, slug) {
  return async (versionId) => {
    try {
      const json = await api(
        manifest,
        `/api/docs/${encodeURIComponent(slug)}/versions/${versionId}`,
      );
      return json?.content ?? null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  };
}

// ── action executors ─────────────────────────────────────────────────────────

/** POST /api/docs — publish (optionally base-checked). Returns the response or
 * throws ApiError (409 carries current_version_id / current_content_hash). */
async function publish(manifest, { slug, content, format, audience, title, sourcePath, path, baseVersionId }) {
  const body = {
    slug,
    title,
    sourcePath: sourcePath ?? slug,
    audience,
    format,
    content,
    ...(path !== undefined ? { path } : {}),
    ...(baseVersionId !== undefined && baseVersionId !== null ? { baseVersionId } : {}),
  };
  return api(manifest, "/api/docs", { method: "POST", body: JSON.stringify(body) });
}

/** POST /api/docs/[slug]/revisions — file a proposed revision. */
async function postRevision(manifest, slug, content, note) {
  return api(manifest, `/api/docs/${encodeURIComponent(slug)}/revisions`, {
    method: "POST",
    body: JSON.stringify({ content, note }),
  });
}

// ── per-file sync ────────────────────────────────────────────────────────────

/**
 * Execute one decision against fs + server. Returns a result line {slug,
 * action, message, reviewUrl?} and mutates `state` (the per-file state object)
 * in place on success. Honors dryRun (logs intended action, no side effects).
 */
async function applyDecision(manifest, decision, ctx) {
  const { state, absPath, format, audience, path, dryRun } = ctx;
  const slug = decision.slug;
  const base = hubUrl(manifest);

  const line = (message, extra = {}) => ({ slug, action: decision.action, message, ...extra });

  switch (decision.action) {
    case "noop": {
      if (decision.nextState && !dryRun) Object.assign(state, decision.nextState);
      return line(decision.reason ?? "in sync");
    }

    case "pull": {
      if (dryRun) return line(`would pull: ${decision.reason}`);
      atomicWrite(absPath, decision.content);
      Object.assign(state, decision.nextState);
      return line(`pulled cloud → ${absPath}`);
    }

    case "push": {
      if (dryRun) return line(`would push local edit (base v${decision.baseVersionId ?? "none"})`);
      try {
        const res = await publish(manifest, {
          slug, content: decision.content, format, audience, path,
          title: titleFor(format, decision.content, slug),
          sourcePath: absPath, baseVersionId: decision.baseVersionId,
        });
        Object.assign(state, {
          lastSyncedVersionId: res.versionId,
          lastSyncedHash: sha256hex(decision.content),
        });
        return line(`pushed → v${res.versionId}`);
      } catch (e) {
        if (e.status === 409) {
          // The doc moved under us → re-enter as both-changed via re-decide.
          return await reenterBoth(manifest, decision.slug, ctx, e);
        }
        throw e;
      }
    }

    case "merge-push": {
      if (dryRun) return line(`would publish clean 3-way merge (base v${decision.baseVersionId})`);
      try {
        const res = await publish(manifest, {
          slug, content: decision.content, format, audience, path,
          title: titleFor(format, decision.content, slug),
          sourcePath: absPath, baseVersionId: decision.baseVersionId,
        });
        // Write the merged content locally too so the replica equals canon.
        atomicWrite(absPath, decision.content);
        Object.assign(state, {
          lastSyncedVersionId: res.versionId,
          lastSyncedHash: sha256hex(decision.content),
        });
        return line(`merged + pushed → v${res.versionId}`);
      } catch (e) {
        if (e.status === 409) return await reenterBoth(manifest, decision.slug, ctx, e);
        throw e;
      }
    }

    case "revision": {
      if (dryRun) return line(`would file proposed revision + pull cloud HEAD`);
      const rev = await postRevision(manifest, slug, decision.content, decision.note);
      // Pull cloud HEAD locally and converge state.
      if (decision.pullAfter) {
        atomicWrite(absPath, decision.pullContent);
        Object.assign(state, decision.nextState);
      }
      const reviewUrl = `${base}/docs/${slug}`;
      const why = decision.reason ?? "filed proposed revision";
      return line(
        `${why} (revision #${rev?.revision?.id ?? "?"}); local set to cloud HEAD. Review: ${reviewUrl}`,
        { reviewUrl },
      );
    }

    case "drop-mapping": {
      // Caller (syncEntries) removes the entry; here we just report.
      return line(decision.reason ?? "remote unpublished — mapping dropped", { dropMapping: true });
    }

    default:
      return line(`unhandled action '${decision.action}'`);
  }
}

/** A push raced a concurrent change (409). Re-fetch remote + re-decide as
 * both-changed and apply that follow-up decision once. */
async function reenterBoth(manifest, slug, ctx, conflictErr) {
  const remoteDoc = await fetchRemoteDoc(manifest, slug);
  const localContent = readLocal(ctx.absPath);
  // Update entry state's base to the conflict's reported base so the merge uses
  // the right common ancestor (the version our push was based on).
  const entry = {
    slug,
    localPath: ctx.absPath,
    lastSyncedVersionId: ctx.state.lastSyncedVersionId,
    lastSyncedHash: ctx.state.lastSyncedHash,
  };
  const d2 = await decideFile({
    entry,
    localContent,
    remoteDoc,
    fetchBase: makeBaseFetcher(manifest, slug),
    merge: (a, b, c) => merge3way(a, b, c),
    hash: sha256hex,
    isMember: isMemberToken(),
    hostname: hostname(),
  });
  const res = await applyDecision(manifest, d2, ctx);
  res.message = `push raced (409) → ${res.message}`;
  return res;
}

function titleFor(format, content, slug) {
  if (format === "md") return extractMdTitle(content) ?? slug;
  return slug;
}

// ── command: link / unlink ───────────────────────────────────────────────────

function cmdLink(positional) {
  const [slug, localPath] = positional;
  if (!slug || !localPath) die("Usage: desk sync link <slug> <localPath>");
  const m = loadManifest();
  const abs = resolve(process.cwd(), localPath);
  if (m.entries.some((e) => e.kind === "file" && e.slug === slug)) {
    die(`slug '${slug}' is already linked`);
  }
  m.entries.push({
    kind: "file",
    slug,
    localPath: abs,
    lastSyncedVersionId: null,
    lastSyncedHash: null,
  });
  saveManifest(m);
  console.log(`linked ${slug} ↔ ${abs}`);
  console.log("run `desk sync` to converge");
}

function cmdLinkDir(positional, flags) {
  const [cloudPrefix, localDir] = positional;
  if (!cloudPrefix || !localDir) die("Usage: desk sync link-dir <cloudPrefix> <localDir> [--audience <a>]");
  // Audience optional (Audiences v2): new local docs adopted under this prefix
  // default to `private` when no --audience is given.
  const audience = flags["audience"] ?? "private";
  const m = loadManifest();
  const abs = resolve(process.cwd(), localDir);
  if (m.entries.some((e) => e.kind === "dir" && e.cloudPathPrefix === cloudPrefix)) {
    die(`prefix '${cloudPrefix}' is already linked`);
  }
  m.entries.push({
    kind: "dir",
    cloudPathPrefix: cloudPrefix,
    localDir: abs,
    audience,
    files: {},
  });
  saveManifest(m);
  console.log(`linked dir ${cloudPrefix}/ ↔ ${abs} (audience: ${audience})`);
  console.log("run `desk sync` to converge");
}

function cmdUnlink(positional) {
  const [key] = positional;
  if (!key) die("Usage: desk sync unlink <slug|prefix>");
  const m = loadManifest();
  const before = m.entries.length;
  m.entries = m.entries.filter(
    (e) =>
      !(e.kind === "file" && e.slug === key) &&
      !(e.kind === "dir" && e.cloudPathPrefix === key),
  );
  if (m.entries.length === before) die(`no linked file or dir matching '${key}'`);
  saveManifest(m);
  console.log(`unlinked ${key} (local file kept)`);
}

// ── command: status ──────────────────────────────────────────────────────────

async function cmdStatus(flags) {
  const m = loadManifest();
  const asJson = !!flags["json"];
  const rows = [];

  for (const entry of m.entries) {
    if (entry.kind === "file") {
      rows.push(await statusRow(m, entry.slug, entry.localPath, entry));
    } else {
      for (const [slug, st] of Object.entries(entry.files)) {
        rows.push(await statusRow(m, slug, st.localPath, st, entry.cloudPathPrefix));
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No linked files. Use `desk sync link` or `desk sync link-dir`.");
    return;
  }
  const header = ["SLUG", "LOCAL", "REMOTE", "BASE", "ACTION", "LAST SYNCED"];
  const table = [header, ...rows.map((r) => [
    r.slug, r.local, r.remote, r.base, r.action, r.lastSynced,
  ])];
  console.log(alignTable(table));
}

async function statusRow(manifest, slug, localPath, st, prefix) {
  const abs = localPath;
  const local = readLocal(abs);
  let remoteDoc = null;
  let remoteErr = null;
  try {
    remoteDoc = await fetchRemoteDoc(manifest, slug);
  } catch (e) {
    remoteErr = e.message;
  }

  const localHash = local === null ? null : sha256hex(local);
  const localState =
    local === null ? "missing"
    : st.lastSyncedHash === null ? "unsynced"
    : localHash === st.lastSyncedHash ? "clean" : "modified";

  const remoteState =
    remoteErr ? "error"
    : remoteDoc === null ? "unpublished"
    : remoteDoc.currentVersionId === st.lastSyncedVersionId ? "current"
    : "ahead";

  const baseState = st.lastSyncedVersionId === null ? "none" : `v${st.lastSyncedVersionId}`;

  // Predicted action (no I/O beyond the fetches above).
  let action = "noop";
  if (remoteErr) action = "?";
  else if (remoteDoc === null) action = "drop-mapping";
  else {
    const localChanged = localState === "modified" || localState === "unsynced";
    const remoteChanged = remoteState === "ahead";
    if (local !== null && localHash === remoteDoc.contentHash) action = "noop";
    else if (localChanged && remoteChanged) action = isMemberToken() ? "revision" : "merge/conflict";
    else if (localChanged) action = isMemberToken() ? "revision" : "push";
    else if (remoteChanged) action = "pull";
  }

  return {
    slug: prefix ? `${prefix}/${slug}` : slug,
    local: localState,
    remote: remoteState,
    base: baseState,
    action,
    lastSynced: st.lastSyncedVersionId ? `v${st.lastSyncedVersionId}` : "-",
  };
}

// ── command: sync (one shot) ─────────────────────────────────────────────────

async function cmdSync(flags) {
  const m = loadManifest();
  const dryRun = !!flags["dry-run"];
  const asJson = !!flags["json"];
  const results = [];

  if (m._corrupt) {
    results.push({ slug: "(manifest)", action: "warn", message: "manifest unreadable — re-link files" });
  }

  // Track entries to drop after the loop (remote-unpublished file links).
  const dropFileSlugs = new Set();

  for (const entry of m.entries) {
    if (entry.kind === "file") {
      const r = await syncFileEntry(m, entry, { dryRun });
      results.push(r);
      if (r.dropMapping && !dryRun) dropFileSlugs.add(entry.slug);
    } else {
      const rs = await syncDirEntry(m, entry, { dryRun });
      results.push(...rs);
    }
  }

  // Apply file-link drops (remote unpublished → keep local, drop mapping).
  if (dropFileSlugs.size > 0) {
    m.entries = m.entries.filter((e) => !(e.kind === "file" && dropFileSlugs.has(e.slug)));
  }

  if (!dryRun) saveManifest(m);

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else if (results.length === 0) {
    console.log("No linked files. Use `desk sync link` or `desk sync link-dir`.");
  } else {
    for (const r of results) {
      console.log(`${r.slug.padEnd(28)} ${r.action.padEnd(13)} ${r.message}`);
    }
  }
}

async function syncFileEntry(manifest, entry, { dryRun }) {
  const abs = entry.localPath;
  const localContent = readLocal(abs);
  let remoteDoc;
  try {
    remoteDoc = await fetchRemoteDoc(manifest, entry.slug);
  } catch (e) {
    return { slug: entry.slug, action: "error", message: e.message };
  }
  // Derive format from extension (local) or remote doc.
  const format = formatFromExt(abs) ?? remoteDoc?.format ?? "md";

  const decision = await decideFile({
    entry,
    localContent,
    remoteDoc,
    fetchBase: makeBaseFetcher(manifest, entry.slug),
    merge: (a, b, c) => merge3way(a, b, c),
    hash: sha256hex,
    isMember: isMemberToken(),
    hostname: hostname(),
  });

  // A file-link republish must preserve the doc's existing audience + path
  // (POST /api/docs requires an audience and would otherwise reset the folder).
  const ctx = {
    state: entry,
    absPath: abs,
    format,
    audience: remoteDoc?.audience,
    path: remoteDoc?.path,
    dryRun,
  };
  try {
    return await applyDecision(manifest, decision, ctx);
  } catch (e) {
    return { slug: entry.slug, action: "error", message: e.message };
  }
}

async function syncDirEntry(manifest, entry, { dryRun }) {
  const results = [];
  const prefix = entry.cloudPathPrefix;

  // 1. Discover remote docs under the prefix.
  let docs = [];
  try {
    const json = await api(manifest, `/api/docs?path=${encodeURIComponent(prefix)}`);
    docs = json.docs ?? [];
  } catch (e) {
    return [{ slug: prefix, action: "error", message: `list failed: ${e.message}` }];
  }
  const remoteBySlug = new Map();
  for (const d of docs) {
    if (d.unpublishedAt) continue;
    remoteBySlug.set(d.slug, { slug: d.slug });
  }

  // 2. Discover local md/html files in the dir → derived slugs.
  const localBySlug = new Map();
  if (existsSync(entry.localDir)) {
    for (const name of readdirSync(entry.localDir)) {
      if (!formatFromExt(name)) continue;
      const slug = slugify(basename(name, extname(name)));
      if (slug) localBySlug.set(slug, { localPath: join(entry.localDir, name) });
    }
  }

  const mapped = new Set(Object.keys(entry.files));

  // 3. Adoption decisions for unmapped names.
  const { adopt } = decideDirAdoptions({
    remoteBySlug, localBySlug, mapped, isMember: isMemberToken(),
  });

  for (const a of adopt) {
    if (a.action === "create-local") {
      const remoteDoc = await fetchRemoteDoc(manifest, a.slug);
      if (!remoteDoc) continue;
      const ext = remoteDoc.format === "html" ? ".html" : ".md";
      const localPath = join(entry.localDir, `${a.slug}${ext}`);
      if (!dryRun) {
        atomicWrite(localPath, remoteDoc.content);
        entry.files[a.slug] = {
          localPath,
          lastSyncedVersionId: remoteDoc.currentVersionId,
          lastSyncedHash: remoteDoc.contentHash,
        };
      }
      results.push({ slug: `${prefix}/${a.slug}`, action: "create-local", message: dryRun ? `would create ${localPath}` : `created ${localPath}` });
    } else if (a.action === "create-remote") {
      const lp = localBySlug.get(a.slug).localPath;
      const content = readLocal(lp);
      const format = formatFromExt(lp) ?? "md";
      if (!dryRun) {
        try {
          const res = await publish(manifest, {
            slug: a.slug, content, format, audience: entry.audience,
            title: titleFor(format, content, a.slug), sourcePath: lp,
            path: prefix,
          });
          entry.files[a.slug] = {
            localPath: lp,
            lastSyncedVersionId: res.versionId,
            lastSyncedHash: sha256hex(content),
          };
          results.push({ slug: `${prefix}/${a.slug}`, action: "create-remote", message: `published → v${res.versionId}` });
        } catch (e) {
          results.push({ slug: `${prefix}/${a.slug}`, action: "error", message: e.message });
        }
      } else {
        results.push({ slug: `${prefix}/${a.slug}`, action: "create-remote", message: `would publish ${lp}` });
      }
    } else if (a.action === "skip-new-local") {
      results.push({ slug: `${prefix}/${a.slug}`, action: "skip", message: a.reason });
    }
  }

  // 4. Sync each already-mapped file via the file algorithm.
  const dropped = [];
  for (const [slug, st] of Object.entries(entry.files)) {
    const abs = st.localPath;
    const localContent = readLocal(abs);
    let remoteDoc;
    try {
      remoteDoc = await fetchRemoteDoc(manifest, slug);
    } catch (e) {
      results.push({ slug: `${prefix}/${slug}`, action: "error", message: e.message });
      continue;
    }
    const format = formatFromExt(abs) ?? remoteDoc?.format ?? "md";
    const fileEntry = { slug, localPath: abs, lastSyncedVersionId: st.lastSyncedVersionId, lastSyncedHash: st.lastSyncedHash };
    const decision = await decideFile({
      entry: fileEntry, localContent, remoteDoc,
      fetchBase: makeBaseFetcher(manifest, slug),
      merge: (a, b, c) => merge3way(a, b, c),
      hash: sha256hex, isMember: isMemberToken(), hostname: hostname(),
    });
    const ctx = { state: st, absPath: abs, format, audience: entry.audience, dryRun };
    try {
      const r = await applyDecision(manifest, decision, ctx);
      r.slug = `${prefix}/${slug}`;
      results.push(r);
      if (r.dropMapping && !dryRun) dropped.push(slug);
    } catch (e) {
      results.push({ slug: `${prefix}/${slug}`, action: "error", message: e.message });
    }
  }
  for (const slug of dropped) delete entry.files[slug];

  if (results.length === 0) {
    results.push({ slug: `${prefix}/`, action: "noop", message: "nothing to sync" });
  }
  return results;
}

// ── shared formatting ────────────────────────────────────────────────────────

function alignTable(rows) {
  if (rows.length === 0) return "";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ")).join("\n");
}

function die(msg) {
  console.error(`desk sync: ${msg}`);
  process.exit(1);
}

// ── entry point (dispatched from desk.mjs) ───────────────────────────────────

export async function runSync(rest, parseFlags) {
  const { flags, positional } = parseFlags(rest);
  const sub = positional[0];
  const subRest = positional.slice(1);

  switch (sub) {
    case "link":
      cmdLink(subRest);
      break;
    case "link-dir":
      cmdLinkDir(subRest, flags);
      break;
    case "unlink":
      cmdUnlink(subRest);
      break;
    case "status":
      await cmdStatus(flags);
      break;
    case undefined:
      await cmdSync(flags);
      break;
    default:
      die(`unknown sync subcommand '${sub}'. Try: link | link-dir | unlink | status | (no arg = sync)`);
  }
}

// Exposed for unit/integration tests.
export const _internals = {
  manifestPath, loadManifest, saveManifest, merge3way, slugify, formatFromExt,
};
