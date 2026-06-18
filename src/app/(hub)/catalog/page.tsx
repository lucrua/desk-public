import { headers } from "next/headers";
import { getPrincipal } from "@/lib/auth";
import { listKinds, listItems, getItem } from "@/lib/catalogs";
import CatalogClient from "./CatalogClient";
import type { CatalogItemDTO, CatalogKindDTO } from "./view-model";

export const dynamic = "force-dynamic";

/**
 * The catalog surface (replaces the disabled "Findings" nav stub). Staff-only
 * (the layout gates anonymous; catalogs are internal — no audience scoping).
 * The server resolves every kind + the active kind's items (with per-item link
 * counts), then hands them to the client island which owns tab switching,
 * status/text filters, the schema editor, and the new-kind form. Mutations go
 * through /api/catalogs; the island re-fetches after each.
 */
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const [principal, { kind: kindParam }] = await Promise.all([
    getPrincipal(await headers()),
    searchParams,
  ]);
  const isAdmin = principal.kind === "admin";

  const kindRows = await listKinds();
  const kinds: CatalogKindDTO[] = kindRows.map((k) => ({
    kind: k.kind,
    label: k.label,
    idPattern: k.idPattern,
    schema: k.schema,
    itemCount: k.itemCount,
  }));

  // Active kind = the ?kind= param if it exists, else the first kind.
  const activeKind =
    (kindParam && kinds.find((k) => k.kind === kindParam)?.kind) ?? kinds[0]?.kind ?? null;

  let items: CatalogItemDTO[] = [];
  let linkCounts: Record<string, { outbound: number; inbound: number }> = {};
  if (activeKind) {
    const rows = await listItems({ kind: activeKind });
    items = rows.map((r) => ({
      kind: r.kind,
      itemId: r.itemId,
      title: r.title,
      status: r.status,
      body: r.body,
      data: (r.data ?? {}) as Record<string, unknown>,
      updatedAt: r.updatedAt.toISOString(),
    }));
    // Per-item link counts for the row summary. Cheap for a registry page.
    const counts: Record<string, { outbound: number; inbound: number }> = {};
    for (const it of rows) {
      const full = await getItem(activeKind, it.itemId);
      counts[it.itemId] = {
        outbound: full?.outbound.length ?? 0,
        inbound: full?.inbound.length ?? 0,
      };
    }
    linkCounts = counts;
  }

  return (
    <CatalogClient
      isAdmin={isAdmin}
      initialKinds={kinds}
      initialActiveKind={activeKind}
      initialItems={items}
      initialLinkCounts={linkCounts}
    />
  );
}
