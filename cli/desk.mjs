#!/usr/bin/env node
/**
 * hub — Desk CLI
 * Node >= 20, zero dependencies (global fetch, node:crypto, node:fs, node:path, node:process)
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import process from "node:process";

// ── Config ────────────────────────────────────────────────────────────────────

const HUB_URL = process.env.HUB_URL ?? "http://localhost:3000";

function authHeaders() {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (id && secret) {
    return {
      "CF-Access-Client-Id": id,
      "CF-Access-Client-Secret": secret,
    };
  }
  return {
    "x-dev-role": process.env.HUB_DEV_ROLE ?? "admin",
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const url = `${HUB_URL}${path}`;
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
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED") || err.message?.includes("fetch failed")) {
      die(`Connection refused — is the hub dev server running? (pnpm dev)\n  URL: ${url}`);
    }
    die(`Network error: ${err.message}`);
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = body.error ?? body.message ?? msg;
    } catch {
      // ignore parse failure
    }
    die(msg);
  }

  return res.json();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(`hub: ${msg}`);
  process.exit(1);
}

function sha256hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** Derive a URL-safe slug from an arbitrary filename stem. */
function slugify(stem) {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Extract first `# heading` text from markdown content. */
function extractMdTitle(content) {
  const match = content.match(/^#[ \t]+(.+)$/m);
  return match ? match[1].trim() : null;
}

/** Derive format from extension. */
function formatFromExt(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".md") return "md";
  if (ext === ".html" || ext === ".htm") return "html";
  return null;
}

/** Align columns for a plain-text table. */
function alignTable(rows) {
  if (rows.length === 0) return "";
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  return rows
    .map((r) => r.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  "))
    .join("\n");
}

function fmtDate(val) {
  if (!val) return "-";
  try {
    return new Date(val).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return String(val);
  }
}

// ── parse args ────────────────────────────────────────────────────────────────

function parseFlags(args) {
  const flags = {};
  const positional = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(a);
      i += 1;
    }
  }
  return { flags, positional };
}

// ── Commands ──────────────────────────────────────────────────────────────────
//
// Write commands (`desk publish`, `desk unpublish`) were RETIRED in the
// Convergence fix-pass (Slice 2): publishing is now a git push (truth = git),
// so the CLI keeps only the READ + SHARE surface. To publish, `git push` to the
// space's `main`; to unpublish, delete the file and push. See README "Publishing".

async function cmdShare(args) {
  const { flags, positional } = parseFlags(args);

  const docSlug = positional[0];
  if (!docSlug) die("Usage: desk share <slug> --label <label> [--expires <days>]");

  const label = flags["label"];
  if (!label) die("--label is required");

  const expiresInDays = flags["expires"] ? Number(flags["expires"]) : undefined;
  if (expiresInDays !== undefined && (!Number.isFinite(expiresInDays) || expiresInDays <= 0)) {
    die("--expires must be a positive number of days");
  }

  const body = { docSlug, label, ...(expiresInDays !== undefined ? { expiresInDays } : {}) };
  const result = await apiFetch("/api/shares", {
    method: "POST",
    body: JSON.stringify(body),
  });

  console.log(result.shareUrl);
  console.log("⚠ shown once — save it now");
}

async function cmdRevoke(args) {
  const arg = args[0];
  if (!arg) die("Usage: desk revoke <id-or-label>");

  let shareId;

  if (/^\d+$/.test(arg)) {
    // All digits — treat as numeric id
    shareId = parseInt(arg, 10);
    const label = await revokById(shareId);
    console.log(`revoked ${shareId} (${label})`);
  } else {
    // Label lookup
    const { shares } = await apiFetch("/api/shares");
    const active = shares.filter((s) => !s.revokedAt && (!s.expiresAt || new Date(s.expiresAt) > new Date()));
    const matches = active.filter((s) => s.label === arg);
    if (matches.length === 0) die(`No active share found with label '${arg}'`);
    if (matches.length > 1) {
      console.error(`hub: Ambiguous label '${arg}' — matches:`);
      for (const m of matches) {
        console.error(`  id=${m.id}  label=${m.label}  doc=${m.docSlug}  created=${fmtDate(m.createdAt)}`);
      }
      process.exit(1);
    }
    shareId = matches[0].id;
    const label = await revokById(shareId);
    console.log(`revoked ${shareId} (${label})`);
  }
}

async function revokById(id) {
  // We need the label for the output — fetch shares first
  const { shares } = await apiFetch("/api/shares");
  const share = shares.find((s) => s.id === id);
  const label = share?.label ?? "?";
  await apiFetch(`/api/shares/${id}/revoke`, { method: "POST" });
  return label;
}

async function cmdList(_args) {
  const [{ docs }, { shares }] = await Promise.all([
    apiFetch("/api/docs"),
    apiFetch("/api/shares"),
  ]);

  // Docs table
  if (docs.length === 0) {
    console.log("No docs.");
  } else {
    const header = ["SLUG", "VERSIONS", "UPDATED", "STATUS"];
    const rows = docs.map((d) => [
      d.slug,
      `v${d.versionCount}`,
      fmtDate(d.updatedAt),
      d.unpublishedAt ? `[unpublished ${fmtDate(d.unpublishedAt)}]` : "published",
    ]);
    console.log("=== Docs ===");
    console.log(alignTable([header, ...rows]));
  }

  console.log("");

  // Shares table
  if (shares.length === 0) {
    console.log("No shares.");
  } else {
    const header = ["ID", "LABEL", "DOC", "VIEWS", "LAST VIEW", "EXPIRES", "STATUS"];
    const rows = shares.map((s) => {
      let status = "active";
      if (s.revokedAt) status = `[revoked ${fmtDate(s.revokedAt)}]`;
      else if (s.expiresAt && new Date(s.expiresAt) <= new Date()) status = `[expired ${fmtDate(s.expiresAt)}]`;
      return [
        String(s.id),
        s.label,
        s.docSlug,
        String(s.viewCount),
        fmtDate(s.lastViewedAt),
        fmtDate(s.expiresAt),
        status,
      ];
    });
    console.log("=== Shares ===");
    console.log(alignTable([header, ...rows]));
  }
}

async function cmdStatus(_args) {
  const { docs } = await apiFetch("/api/docs");

  if (docs.length === 0) {
    console.log("No docs.");
    return;
  }

  const results = await Promise.all(
    docs.map(async (doc) => {
      // Fetch detail — this gives us sourcePath (not in the list response) and the hash.
      let detail;
      try {
        detail = await apiFetch(`/api/docs/${doc.slug}`);
      } catch {
        return { slug: doc.slug, status: "could not fetch doc detail" };
      }

      const sourcePath = detail.doc?.sourcePath ?? "";
      if (!sourcePath) {
        return { slug: doc.slug, status: "source file not found (no sourcePath recorded)" };
      }

      const candidates = [
        resolve(process.cwd(), sourcePath),
        ...(process.env.DESK_SOURCE_ROOT ? [resolve(process.env.DESK_SOURCE_ROOT, sourcePath)] : []),
      ].filter(Boolean);

      const found = candidates.find((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });

      if (!found) {
        return { slug: doc.slug, status: `source file not found (tried: ${candidates.join(", ")})` };
      }

      const currentHash = detail.currentVersion?.contentHash ?? detail.versions?.[0]?.contentHash ?? null;

      if (!currentHash) {
        return { slug: doc.slug, status: "no published version" };
      }

      const localContent = readFileSync(found, "utf8");
      const localHash = sha256hex(localContent);

      if (localHash === currentHash) {
        return { slug: doc.slug, status: "in sync" };
      } else {
        return { slug: doc.slug, status: "canon ahead — re-publish?" };
      }
    })
  );

  const header = ["SLUG", "STATUS"];
  const rows = results.map((r) => [r.slug, r.status]);
  console.log(alignTable([header, ...rows]));
}

function cmdHelp() {
  console.log(`hub — Desk CLI  (read + share surface)

Publishing is a git push — 'git push <remote> HEAD:main' to the space's repo
(truth = git; Desk re-renders within seconds). The CLI's write commands
(publish / unpublish) were retired in the Convergence fix-pass. See the
README "Publishing" section.

Commands:
  desk share <slug> --label <label> [--expires <days>]
      Create a capability share link for a doc. URL printed once — save it.

  desk revoke <id-or-label>
      Revoke a share. If all-digits, treated as numeric id; else looked up by label.

  desk list
      List all docs and shares in aligned plain-text tables.

  desk status
      For each doc whose sourcePath resolves locally: compare sha256 of local file to
      the published version. Prints: in sync | canon ahead (push?) | source file not found.

  desk help
      Show this usage.

Environment:
  HUB_URL            Hub base URL (default: http://localhost:3000)
  HUB_DEV_ROLE       Dev-mode role header value (default: admin)
  CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET
                     Cloudflare Access service token (if set, used instead of x-dev-role)

Alias:
  alias desk='node ~/desk/cli/desk.mjs'
`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case "share":      await cmdShare(rest); break;
  case "revoke":     await cmdRevoke(rest); break;
  case "list":       await cmdList(rest); break;
  case "status":     await cmdStatus(rest); break;
  case "publish":
  case "unpublish":
    console.error(`hub: '${cmd}' was retired — publishing is now 'git push' to the space's main branch (truth = git). See the README "Publishing" section.`);
    process.exit(1);
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:    cmdHelp(); break;
  default:
    console.error(`hub: unknown command '${cmd}'. Run 'desk help' for usage.`);
    process.exit(1);
}
