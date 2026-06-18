import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPrincipal } from "@/lib/auth";
import { getSchema, getItem, listActivePatterns } from "@/lib/catalogs";
import Markdown from "@/components/Markdown";
import { schemaFields, statusChip, inverseLinkLabel } from "../../view-model";

export const dynamic = "force-dynamic";

const mono = "var(--font-mono)";
const label10 = {
  fontFamily: mono,
  fontSize: 10.5,
  letterSpacing: "0.08em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
};

/**
 * A single catalog item. Staff-only (the hub layout gates anonymous; catalogs
 * are internal). Renders: the markdown body (auto-linking other catalog ids for
 * staff), a schema-driven field table (rows in JSON Schema property ORDER,
 * absent optionals as em-dash), and a links panel split outbound / inbound with
 * typed inverse labels — every link navigable. Mirrors the Catalog.dc.html
 * round-2 item page.
 */
export default async function CatalogItemPage({
  params,
}: {
  params: Promise<{ kind: string; itemId: string }>;
}) {
  const [{ kind, itemId: rawItemId }, principal] = await Promise.all([
    params,
    getPrincipal(await headers()),
  ]);
  void principal; // staff-gated by layout; presence is enough
  const itemId = decodeURIComponent(rawItemId);

  const [schema, result, patterns] = await Promise.all([
    getSchema(kind),
    getItem(kind, itemId),
    listActivePatterns(),
  ]);
  if (!schema || !result) notFound();

  const { item, outbound, inbound } = result;
  const fields = schemaFields(schema.schema, (item.data ?? {}) as Record<string, unknown>);
  const sc = statusChip(item.status);

  return (
    <main
      style={{
        maxWidth: 1060,
        margin: "0 auto",
        padding: "26px 20px 80px",
        display: "flex",
        gap: 36,
        alignItems: "flex-start",
      }}
    >
      <article style={{ flex: 1, minWidth: 0 }}>
        <Link href={`/catalog?kind=${encodeURIComponent(kind)}`} style={{ fontSize: 12.5, color: "var(--muted)", textDecoration: "none", display: "inline-block", marginBottom: 16 }}>
          ← {schema.label}
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
          <span style={{ fontFamily: mono, fontSize: 15, fontWeight: 600, color: "var(--ref-ink)" }}>{item.itemId}</span>
          <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.015em", margin: 0 }}>{item.title}</h1>
          {item.status && (
            <span style={{ fontFamily: mono, fontSize: 10, padding: "3px 8px", borderRadius: 99, background: sc.bg, color: sc.ink }}>
              {item.status}
            </span>
          )}
        </div>
        <div style={{ fontFamily: mono, fontSize: 11, color: "var(--faint)", marginBottom: 22 }}>
          kind: {item.kind} · updated {item.updatedAt.toISOString().slice(0, 10)}
        </div>

        {item.body.trim().length > 0 ? (
          <Markdown content={item.body} register="operator" catalogPatterns={patterns} />
        ) : (
          <p style={{ fontSize: 13.5, color: "var(--faint)" }}>No description.</p>
        )}

        {/* schema-driven field table */}
        <div style={{ marginTop: 26 }}>
          <div style={{ ...label10, marginBottom: 8 }}>Fields · from JSON Schema &ldquo;{item.kind}&rdquo;</div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", overflow: "hidden" }}>
            {fields.length === 0 ? (
              <div style={{ padding: "12px 14px", fontSize: 13, color: "var(--faint)" }}>No declared fields.</div>
            ) : (
              fields.map((f) => (
                <div key={f.key} style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ width: 150, flex: "none", padding: "9px 14px", fontFamily: mono, fontSize: 11, color: "var(--muted)", background: "var(--surface-alt)" }}>
                    {f.key}
                  </span>
                  <span style={{ flex: 1, padding: "9px 14px", fontSize: 13, color: f.present ? "var(--ink)" : "var(--faint)" }}>
                    {f.value}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </article>

      {/* links panel */}
      <aside style={{ width: 280, flex: "none", display: "flex", flexDirection: "column", gap: 18 }}>
        <div>
          <div style={{ ...label10, marginBottom: 10 }}>Links · outbound</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {outbound.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--faint)", padding: "2px 0" }}>No outbound links.</div>
            ) : (
              outbound.map((e) => (
                <LinkCard
                  key={`out-${e.toKind}-${e.toItemId}-${e.linkType}`}
                  type={e.linkType}
                  targetKind={e.toKind}
                  targetId={e.toItemId}
                  alt="surface"
                />
              ))
            )}
          </div>
        </div>
        <div>
          <div style={{ ...label10, marginBottom: 10 }}>Links · inbound</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {inbound.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--faint)", padding: "2px 0" }}>Nothing links here yet.</div>
            ) : (
              inbound.map((e) => (
                <LinkCard
                  key={`in-${e.fromKind}-${e.fromItemId}-${e.linkType}`}
                  type={inverseLinkLabel(e.linkType)}
                  targetKind={e.fromKind}
                  targetId={e.fromItemId}
                  alt="surfaceAlt"
                />
              ))
            )}
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--faint)", lineHeight: 1.5 }}>
          Links are typed edges between catalog items. They render as navigable refs everywhere this id appears.
        </div>
      </aside>
    </main>
  );
}

function LinkCard({
  type,
  targetKind,
  targetId,
  alt,
}: {
  type: string;
  targetKind: string;
  targetId: string;
  alt: "surface" | "surfaceAlt";
}) {
  return (
    <Link
      href={`/catalog/${encodeURIComponent(targetKind)}/${encodeURIComponent(targetId)}`}
      style={{
        display: "block",
        border: "1px solid var(--border)",
        borderRadius: 9,
        background: alt === "surfaceAlt" ? "var(--surface-alt)" : "var(--surface)",
        padding: "9px 12px",
        textDecoration: "none",
      }}
    >
      <div style={{ ...label10, fontSize: 10, letterSpacing: "0.05em", marginBottom: 3 }}>{type}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ fontFamily: mono, fontSize: 11.5, fontWeight: 600, color: "var(--ref-ink)" }}>{targetId}</span>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{targetKind}</span>
      </div>
    </Link>
  );
}
