"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  type CatalogKindDTO,
  type CatalogItemDTO,
  statusChip,
  previewSchema,
  checkIdPattern,
  linkSummary,
} from "./view-model";

type LinkCounts = Record<string, { outbound: number; inbound: number }>;
type View = "list" | "schema" | "newkind";

type Props = {
  isAdmin: boolean;
  initialKinds: CatalogKindDTO[];
  initialActiveKind: string | null;
  initialItems: CatalogItemDTO[];
  initialLinkCounts: LinkCounts;
};

const mono = "var(--font-mono)";

const label10 = {
  fontFamily: mono,
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
};

/**
 * The catalog island. Owns kind-tab switching (re-fetches that kind's items via
 * GET /api/catalogs/[kind]/items), the status + text filters, the item table,
 * and — for admins — the schema editor (live regex + validation preview) and the
 * new-kind form. Item pages live at /catalog/[kind]/[itemId] (server-rendered);
 * rows are <Link>s. Mirrors the Catalog.dc.html round-2 mock.
 */
export default function CatalogClient({
  isAdmin,
  initialKinds,
  initialActiveKind,
  initialItems,
  initialLinkCounts,
}: Props) {
  const [kinds, setKinds] = useState<CatalogKindDTO[]>(initialKinds);
  const [activeKind, setActiveKind] = useState<string | null>(initialActiveKind);
  const [items, setItems] = useState<CatalogItemDTO[]>(initialItems);
  const [linkCounts, setLinkCounts] = useState<LinkCounts>(initialLinkCounts);
  const [view, setView] = useState<View>("list");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  const kind = useMemo(() => kinds.find((k) => k.kind === activeKind) ?? null, [kinds, activeKind]);

  // ── data refresh ───────────────────────────────────────────────────────────
  const refreshItems = useCallback(async (k: string) => {
    const res = await fetch(`/api/catalogs/${encodeURIComponent(k)}/items`, { cache: "no-store" });
    if (!res.ok) return;
    const { items: rows } = (await res.json()) as { items: CatalogItemDTO[] };
    setItems(rows);
    // Link counts come from each item's get (outbound/inbound length).
    const counts: LinkCounts = {};
    await Promise.all(
      rows.map(async (it) => {
        const r = await fetch(`/api/catalogs/${encodeURIComponent(k)}/items/${encodeURIComponent(it.itemId)}`, { cache: "no-store" });
        if (r.ok) {
          const full = (await r.json()) as { outbound: unknown[]; inbound: unknown[] };
          counts[it.itemId] = { outbound: full.outbound.length, inbound: full.inbound.length };
        }
      }),
    );
    setLinkCounts(counts);
  }, []);

  const refreshKinds = useCallback(async () => {
    const res = await fetch(`/api/catalogs`, { cache: "no-store" });
    if (!res.ok) return;
    const { kinds: ks } = (await res.json()) as { kinds: CatalogKindDTO[] };
    setKinds(ks);
  }, []);

  const switchKind = useCallback(
    (k: string) => {
      setActiveKind(k);
      setView("list");
      setStatusFilter("all");
      setQuery("");
      void refreshItems(k);
    },
    [refreshItems],
  );

  // ── filtered rows ──────────────────────────────────────────────────────────
  const statuses = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.status) set.add(it.status);
    return ["all", ...Array.from(set)];
  }, [items]);

  const filtered = useMemo(
    () =>
      items
        .filter((i) => statusFilter === "all" || i.status === statusFilter)
        .filter((i) => !query || `${i.itemId} ${i.title}`.toLowerCase().includes(query.toLowerCase())),
    [items, statusFilter, query],
  );

  // ── empty: no kinds at all ─────────────────────────────────────────────────
  if (kinds.length === 0) {
    return (
      <main style={{ maxWidth: 920, margin: "0 auto", padding: "28px 20px 80px" }}>
        <div style={{ border: "1px dashed var(--border)", borderRadius: 10, padding: "40px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No catalog kinds yet</div>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>
            {isAdmin
              ? 'Create a kind to start a registry (e.g. "Findings" with id pattern F-\\d+).'
              : "An admin hasn't defined any registries yet."}
          </div>
          {isAdmin && (
            <button onClick={() => setView("newkind")} style={dashedBtn} data-testid="new-kind-empty">
              + New kind
            </button>
          )}
        </div>
        {view === "newkind" && isAdmin && (
          <NewKindForm
            onCancel={() => setView("list")}
            onCreated={async (newKind) => {
              await refreshKinds();
              setActiveKind(newKind);
              setItems([]);
              setLinkCounts({});
              setView("list");
            }}
          />
        )}
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "28px 20px 80px" }}>
      {/* kind tabs */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 20 }}>
        {kinds.map((k) => {
          const active = k.kind === activeKind;
          return (
            <button
              key={k.kind}
              onClick={() => switchKind(k.kind)}
              aria-current={active ? "page" : undefined}
              style={{
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                padding: "9px 13px 10px",
                border: "none",
                borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
                background: "none",
                color: active ? "var(--ink)" : "var(--muted)",
                cursor: "pointer",
                marginBottom: -1,
              }}
            >
              {k.label}
              <span style={{ fontFamily: mono, fontSize: 10, color: "var(--faint)", marginLeft: 6 }}>{k.itemCount}</span>
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        {isAdmin && (
          <button onClick={() => setView("newkind")} style={dashedBtn} data-testid="new-kind">
            + New kind
          </button>
        )}
      </div>

      {kind && view === "list" && (
        <>
          {/* title row */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 4 }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 }}>{kind.label}</h1>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: mono, fontSize: 10.5, color: "var(--faint)" }}>id pattern {kind.idPattern}</span>
              {isAdmin ? (
                <button onClick={() => setView("schema")} style={solidBtn} data-testid="edit-schema">
                  Edit schema
                </button>
              ) : (
                <span
                  style={{ ...label10, padding: "3px 8px", borderRadius: 4, background: "var(--hover)" }}
                  data-testid="readonly-tag"
                >
                  read-only
                </span>
              )}
            </div>
          </div>
          <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--muted)" }}>
            Schema-defined registry. {filtered.length} shown.
          </p>

          {/* search + status filter */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${kind.label.toLowerCase()} — id or title…`}
              style={{
                flex: 1,
                minWidth: 220,
                padding: "8px 12px",
                fontSize: 13,
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--surface)",
                color: "var(--ink)",
                outline: "none",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={label10}>status</span>
              {statuses.map((s) => {
                const active = statusFilter === s;
                return (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      padding: "4px 11px",
                      borderRadius: 99,
                      border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                      background: active ? "var(--ok-bg)" : "var(--surface)",
                      color: active ? "var(--accent)" : "var(--muted)",
                      cursor: "pointer",
                    }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </div>

          {/* table */}
          {filtered.length > 0 ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 16px 7px", ...label10 }}>
                <span style={{ width: 64, flex: "none" }}>id</span>
                <span style={{ flex: 1 }}>title</span>
                <span style={{ width: 86, textAlign: "center" }}>status</span>
                <span style={{ width: 78, textAlign: "right" }}>updated</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {filtered.map((it) => {
                  const sc = statusChip(it.status);
                  const counts = linkCounts[it.itemId] ?? { outbound: 0, inbound: 0 };
                  return (
                    <Link
                      key={it.itemId}
                      href={`/catalog/${encodeURIComponent(it.kind)}/${encodeURIComponent(it.itemId)}`}
                      style={{
                        textAlign: "left",
                        border: "1px solid var(--border)",
                        borderRadius: 10,
                        background: "var(--surface)",
                        padding: "12px 16px",
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        color: "var(--ink)",
                        textDecoration: "none",
                      }}
                    >
                      <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: "var(--ref-ink)", width: 64, flex: "none" }}>
                        {it.itemId}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{it.title}</div>
                        <div style={{ fontSize: 12, color: "var(--muted)" }}>{linkSummary(counts.outbound, counts.inbound)}</div>
                      </div>
                      <span style={{ width: 86, flex: "none", textAlign: "center" }}>
                        {it.status && (
                          <span style={{ fontFamily: mono, fontSize: 10, padding: "3px 8px", borderRadius: 99, background: sc.bg, color: sc.ink }}>
                            {it.status}
                          </span>
                        )}
                      </span>
                      <span style={{ fontFamily: mono, fontSize: 11, color: "var(--faint)", width: 78, textAlign: "right" }}>
                        {it.updatedAt.slice(0, 10)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </>
          ) : (
            <div style={{ border: "1px dashed var(--border)", borderRadius: 10, padding: "40px 20px", textAlign: "center" }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 4 }}>
                {query ? `No matches for "${query}"` : `No ${kind.label.toLowerCase()} yet`}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                {query
                  ? "Search covers ids and titles within this kind."
                  : `Items arrive from people or agents via POST /api/catalogs/${kind.kind}/items.`}
              </div>
            </div>
          )}
        </>
      )}

      {kind && view === "schema" && isAdmin && (
        <SchemaEditor
          kind={kind}
          sampleItem={items[0] ?? null}
          onCancel={() => setView("list")}
          onSaved={async () => {
            await refreshKinds();
            setView("list");
          }}
        />
      )}

      {view === "newkind" && isAdmin && (
        <NewKindForm
          onCancel={() => setView("list")}
          onCreated={async (newKind) => {
            await refreshKinds();
            setActiveKind(newKind);
            setItems([]);
            setLinkCounts({});
            setView("list");
          }}
        />
      )}
    </main>
  );
}

// ── Schema editor ──────────────────────────────────────────────────────────────

function SchemaEditor({
  kind,
  sampleItem,
  onCancel,
  onSaved,
}: {
  kind: CatalogKindDTO;
  sampleItem: CatalogItemDTO | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [schemaText, setSchemaText] = useState(() => JSON.stringify(kind.schema ?? {}, null, 2));
  const [patternText, setPatternText] = useState(kind.idPattern);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sampleData = sampleItem?.data ?? null;
  const sampleId = sampleItem?.itemId ?? null;
  const preview = useMemo(() => previewSchema(schemaText, sampleData, kind.itemCount), [schemaText, sampleData, kind.itemCount]);
  const patternCheck = useMemo(() => checkIdPattern(patternText, sampleId), [patternText, sampleId]);

  const save = useCallback(async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(schemaText);
    } catch {
      setError("Schema is not valid JSON");
      return;
    }
    const res = await fetch(`/api/catalogs/${encodeURIComponent(kind.kind)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idPattern: patternText, schema: parsed }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "Save failed");
      return;
    }
    setSaved(true);
    onSaved();
  }, [schemaText, patternText, kind.kind, onSaved]);

  return (
    <div style={{ animation: "none" }}>
      <button onClick={onCancel} style={backLink}>
        ← {kind.label}
      </button>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px" }}>Schema — kind &ldquo;{kind.kind}&rdquo;</h1>
      <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--muted)", maxWidth: 620 }}>
        Schema-as-data: saving is an API call, not a redeploy. Additive changes apply immediately; breaking changes flag existing items for migration.
      </p>
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: 1.4, minWidth: 380 }}>
          <div style={{ ...label10, marginBottom: 8 }}>JSON Schema</div>
          <textarea
            value={schemaText}
            onChange={(e) => { setSchemaText(e.target.value); setSaved(false); }}
            spellCheck={false}
            data-testid="schema-textarea"
            style={{
              width: "100%",
              height: 360,
              padding: "14px 16px",
              fontFamily: mono,
              fontSize: 12,
              lineHeight: 1.65,
              border: "1px solid var(--border)",
              borderRadius: 10,
              background: "var(--surface)",
              color: "var(--ink)",
              outline: "none",
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
            <span style={{ fontFamily: mono, fontSize: 10.5, color: "var(--faint)" }}>id pattern</span>
            <input
              value={patternText}
              onChange={(e) => { setPatternText(e.target.value); setSaved(false); }}
              data-testid="pattern-input"
              style={{ width: 160, padding: "5px 9px", fontFamily: mono, fontSize: 12, border: "1px solid var(--border)", borderRadius: 7, background: "var(--surface)", color: "var(--ink)", outline: "none" }}
            />
            <span style={{ fontSize: 11.5, color: !patternCheck.valid ? "var(--danger-ink)" : patternCheck.matches ? "var(--ok-ink)" : "var(--warn-ink)" }}>
              {!patternCheck.valid
                ? "not a valid regex"
                : patternCheck.matches == null
                  ? "no sample to check"
                  : patternCheck.matches
                    ? `✓ matches ${sampleId}`
                    : `✕ doesn't match ${sampleId}`}
            </span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 300 }}>
          <div style={{ ...label10, marginBottom: 8 }}>
            Validation preview · {sampleId ?? "—"} against draft
          </div>
          <div
            data-testid="schema-preview"
            style={{
              border: `1px solid ${preview.kind === "parse-error" || (preview.kind === "report" && !preview.valid) ? "var(--danger-border)" : "var(--ok-bg)"}`,
              background: preview.kind === "parse-error" || (preview.kind === "report" && !preview.valid) ? "var(--danger-bg)" : "var(--ok-bg)",
              borderRadius: 10,
              padding: "14px 16px",
              marginBottom: 12,
            }}
          >
            {preview.kind === "parse-error" ? (
              <>
                <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: "var(--danger-ink)", marginBottom: 4 }}>✕ schema is not valid JSON</div>
                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{preview.message}</div>
              </>
            ) : (
              <>
                <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: preview.valid ? "var(--ok-ink)" : "var(--danger-ink)", marginBottom: 4 }}>
                  {preview.valid ? `✓ valid — ${sampleId ?? "sample"} passes` : `✕ invalid — ${sampleId ?? "sample"} fails`}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
                  {preview.valid
                    ? "All required fields present; enums check out."
                    : `Saving would flag ${preview.migrationCount} item(s) for migration.`}
                </div>
              </>
            )}
          </div>
          {preview.kind === "report" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {preview.checks.map((c) => (
                <div key={c.field} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5 }}>
                  <span style={{ fontFamily: mono, fontSize: 11, width: 14, flex: "none", color: c.status === "ok" ? "var(--ok-ink)" : c.status === "absent-optional" ? "var(--faint)" : "var(--danger-ink)" }}>
                    {c.status === "ok" ? "✓" : c.status === "absent-optional" ? "·" : "✕"}
                  </span>
                  <span style={{ fontFamily: mono, fontSize: 11.5, color: "var(--muted)" }}>{c.field}</span>
                  <span style={{ color: "var(--faint)", fontSize: 11.5 }}>{c.note}</span>
                </div>
              ))}
            </div>
          )}
          <button onClick={() => void save()} style={{ ...primaryBtn, marginTop: 16 }} data-testid="save-schema">
            Save schema
          </button>
          {error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--danger-ink)" }}>{error}</div>}
          {saved && !error && <div style={{ marginTop: 10, fontSize: 12, color: "var(--ref-ink)" }}>Saved.</div>}
        </div>
      </div>
    </div>
  );
}

// ── New-kind form ───────────────────────────────────────────────────────────────

function NewKindForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (kind: string) => void;
}) {
  const [labelText, setLabelText] = useState("");
  const [patternText, setPatternText] = useState("");
  const [schemaText, setSchemaText] = useState(
    '{\n  "type": "object",\n  "required": [],\n  "properties": {\n  },\n  "additionalProperties": false\n}',
  );
  const [note, setNote] = useState("");

  const create = useCallback(async () => {
    setNote("");
    const label = labelText.trim();
    const pat = patternText.trim();
    if (!label || !pat) { setNote("Label and id pattern are required."); return; }
    if (!checkIdPattern(pat, null).valid) { setNote("Id pattern is not a valid regex."); return; }
    let schema: unknown;
    try { schema = JSON.parse(schemaText); } catch { setNote("Starter schema is not valid JSON."); return; }
    const kind = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    if (!kind) { setNote("Label must contain at least one letter or digit."); return; }
    const res = await fetch(`/api/catalogs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, label, idPattern: pat, schema }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setNote(j.error ?? "Create failed");
      return;
    }
    onCreated(kind);
  }, [labelText, patternText, schemaText, onCreated]);

  return (
    <div style={{ maxWidth: 640, margin: "24px auto 0" }}>
      <button onClick={onCancel} style={backLink}>← back</button>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px" }}>New kind</h1>
      <p style={{ margin: "0 0 22px", fontSize: 13, color: "var(--muted)" }}>
        A kind is a registry: a label, an id pattern, and a JSON Schema for its structured fields. Items and links come later — from people or agents.
      </p>

      <label style={{ ...label10, display: "block", marginBottom: 6 }}>label (plural)</label>
      <input value={labelText} onChange={(e) => setLabelText(e.target.value)} placeholder="e.g. Experiments" data-testid="nk-label" style={nkInput} />

      <label style={{ ...label10, display: "block", marginBottom: 6, marginTop: 14 }}>id pattern (regex)</label>
      <input value={patternText} onChange={(e) => setPatternText(e.target.value)} placeholder="e.g. EXP-\d+" data-testid="nk-pattern" style={{ ...nkInput, fontFamily: mono }} />

      <label style={{ ...label10, display: "block", marginBottom: 6, marginTop: 14 }}>starter schema</label>
      <textarea
        value={schemaText}
        onChange={(e) => setSchemaText(e.target.value)}
        spellCheck={false}
        data-testid="nk-schema"
        style={{ ...nkInput, height: 190, fontFamily: mono, fontSize: 12, lineHeight: 1.6, resize: "vertical" }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
        <button onClick={() => void create()} style={primaryBtn} data-testid="create-kind">Create kind</button>
        {note && <span style={{ fontSize: 12, color: "var(--danger-ink)" }}>{note}</span>}
      </div>
    </div>
  );
}

// ── shared styles ───────────────────────────────────────────────────────────────

const dashedBtn = {
  fontSize: 12,
  fontWeight: 500,
  padding: "5px 11px",
  borderRadius: 7,
  border: "1px dashed var(--border)",
  background: "none",
  color: "var(--muted)",
  cursor: "pointer",
  marginBottom: 7,
} as const;

const solidBtn = {
  fontSize: 12.5,
  fontWeight: 500,
  padding: "6px 12px",
  borderRadius: 7,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--ink)",
  cursor: "pointer",
} as const;

const primaryBtn = {
  fontSize: 13,
  fontWeight: 500,
  padding: "8px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
} as const;

const backLink = {
  fontSize: 12.5,
  color: "var(--muted)",
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: 0,
  marginBottom: 16,
  display: "block",
} as const;

const nkInput = {
  width: "100%",
  padding: "8px 11px",
  fontSize: 13,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface)",
  color: "var(--ink)",
  outline: "none",
} as const;
