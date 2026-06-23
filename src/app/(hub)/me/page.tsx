import { headers } from "next/headers";
import Link from "next/link";
import { eq, or } from "drizzle-orm";
import { getPrincipal } from "@/lib/auth";
import { db, schema } from "@/db";
import { listDocs, scopeForPrincipal } from "@/lib/docs";
import { dateStamp } from "../docs/view-model";
import { maskToken } from "./view-model";

export const dynamic = "force-dynamic";

const labelStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
  marginBottom: 4,
};

const valueStyle = {
  fontSize: 13.5,
  color: "var(--ink)",
} as const;

const monoValue = {
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  color: "var(--muted)",
} as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

export default async function MePage() {
  const principal = await getPrincipal(await headers());

  // Layout already blocks anonymous; principal is admin | member here.
  const role = principal.kind === "admin" ? "admin" : "member";
  const email = principal.kind !== "anonymous" ? principal.email : undefined;
  const tokenName = principal.kind !== "anonymous" ? principal.tokenName : undefined;
  const name = principal.kind !== "anonymous" ? principal.name : "—";

  // Resolve the backing users row (when one exists) for createdAt. Dev-mode
  // principals carry neither email nor tokenName → no row, rendered gracefully.
  let row: typeof schema.users.$inferSelect | undefined;
  if (email || tokenName) {
    row = await db.query.users.findFirst({
      where: or(
        email ? eq(schema.users.email, email) : undefined,
        tokenName ? eq(schema.users.tokenName, tokenName) : undefined,
      ),
    });
  }
  const hasRow = row != null;

  // "What you can see" — count of docs visible to this principal via the same
  // scoped service call the docs list uses.
  const visibleDocs = await listDocs({
    includeUnpublished: role === "admin",
    scope: await scopeForPrincipal(principal),
  });

  const roleChipStyle = {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    padding: "3px 10px",
    borderRadius: 999,
    border: "1px solid",
    borderColor: role === "admin" ? "var(--ref-border)" : "var(--hairline)",
    background: role === "admin" ? "var(--ref-bg)" : "var(--surface-alt)",
    color: role === "admin" ? "var(--ref-ink)" : "var(--faint)",
  } as const;

  return (
    <div style={{ maxWidth: 620, margin: "0 auto", padding: "32px 20px 80px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 }}>
          {name}
        </h1>
        <span style={roleChipStyle}>{role}</span>
      </div>
      <p style={{ margin: "0 0 24px", fontSize: 13, color: "var(--muted)" }}>
        Your Desk identity — derived from how you signed in.
      </p>

      <div
        style={{
          border: "1px solid var(--hairline)",
          borderRadius: 12,
          background: "var(--surface)",
          padding: "20px 22px",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "18px 24px",
        }}
      >
        <Field label="email">
          <span style={email ? monoValue : { ...monoValue, color: "var(--faint)" }}>
            {email ?? "—"}
          </span>
        </Field>
        <Field label="service token">
          <span style={tokenName ? monoValue : { ...monoValue, color: "var(--faint)" }}>
            {maskToken(tokenName)}
          </span>
        </Field>
        <Field label="member since">
          <span style={monoValue}>{hasRow ? dateStamp(row!.createdAt) : "—"}</span>
        </Field>
        <Field label="account">
          <span style={valueStyle}>
            {hasRow ? "active" : "no account row (dev mode)"}
          </span>
        </Field>
      </div>

      <div
        style={{
          marginTop: 18,
          border: "1px solid var(--hairline)",
          borderRadius: 12,
          background: "var(--surface-alt)",
          padding: "16px 20px",
        }}
      >
        <div style={labelStyle}>what you can see</div>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: "var(--ink)" }}>
          {visibleDocs.length} {visibleDocs.length === 1 ? "doc is" : "docs are"} visible to you.{" "}
          {role === "admin"
            ? "As the admin you see every doc, including unpublished ones."
            : "Members see published docs in spaces they belong to (plus public/unlisted spaces)."}{" "}
          <Link href="/spaces" style={{ color: "var(--accent)", textDecoration: "none" }}>
            Open spaces →
          </Link>
        </p>
      </div>
    </div>
  );
}
