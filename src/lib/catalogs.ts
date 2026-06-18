import { eq, and, asc, desc, sql, ilike, or } from "drizzle-orm";
import Ajv, { type ValidateFunction } from "ajv";
import { db } from "@/db";
import { catalogSchemas, catalogItems, catalogLinks } from "@/db/schema";
import { emitEvent } from "@/lib/events";
import { MAX_CARD_BODY_CHARS } from "@/lib/limits";
import { idPatternGuard } from "@/lib/catalog-refs";

/**
 * Catalogs — generic "schema-as-data" registries (P3). A *kind* (finding,
 * decision, rfc, …) is a row in `catalog_schemas`: a slug `kind`, a `label`, an
 * `idPattern` (regex SOURCE), and a JSON Schema for the item `data` payload. Its
 * items live in `catalog_items` (human `itemId` validated against the pattern,
 * `data` validated against the schema), and typed cross-links between items live
 * in `catalog_links` — DERIVED at write time by scanning the item's body + data
 * for OTHER kinds' idPatterns (plus own-kind references, excluding self).
 *
 * Authorization (enforced at the call sites — routes + MCP tools):
 *   - reads (listKinds, getSchema, listItems, getItem) → any staff principal.
 *   - ALL writes (schema upsert/delete, item upsert/delete) → admin only.
 *
 * Every mutation emits a catalog.* event in-transaction. Item-event payloads
 * carry kind/itemId/title/status only — never the body or data payload.
 *
 * The id is CLIENT-PROPOSED, server-validated: callers supply `F-012`; we
 * reject it if it doesn't match the kind's anchored idPattern. We never mint
 * ids server-side.
 */

// ── slug + caps ──────────────────────────────────────────────────────────────

/** Same slug contract buckets/audiences/docs use, for the `kind` key. */
export const KIND_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Item body cap — registries hold short notes, not documents (reuse card cap). */
export const MAX_CATALOG_BODY_CHARS = MAX_CARD_BODY_CHARS;

// ── Result type ──────────────────────────────────────────────────────────────

export type CatalogResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: "not-found" | "invalid" | "conflict" };

function ok<T>(value: T): CatalogResult<T> {
  return { ok: true, value };
}
function bad<T>(error: string, code?: "not-found" | "invalid" | "conflict"): CatalogResult<T> {
  return { ok: false, error, code };
}

// ── ajv (shared instance) ────────────────────────────────────────────────────

// One ajv instance for compiling item schemas. `strict: false` so a hand-written
// JSON Schema with extra/unknown keywords (or `$id`) doesn't throw — we only
// need structural validation, not strict-mode pedantry.
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Compile a JSON Schema with ajv, returning the validator or an error string.
 * Used both to VALIDATE A SCHEMA ITSELF (does it compile?) on schema upsert, and
 * to validate item `data` against its kind's schema.
 */
function compileSchema(schema: unknown): { ok: true; validate: ValidateFunction } | { ok: false; error: string } {
  if (schema == null || typeof schema !== "object" || Array.isArray(schema)) {
    return { ok: false, error: "schema must be a JSON object" };
  }
  try {
    const validate = ajv.compile(schema as object);
    return { ok: true, validate };
  } catch (e) {
    return { ok: false, error: `invalid JSON Schema: ${(e as Error).message}` };
  }
}

/**
 * Compile an idPattern (regex source) anchored as ^(…)$ — the same anchoring
 * used for id validation AND auto-linking, so the two never drift. Returns the
 * RegExp or an error string.
 *
 * Applies the static ReDoS guard (length cap + nested-quantifier rejection from
 * catalog-refs.ts) BEFORE compiling: idPatterns run against every doc/card body
 * on every staff render, so a backtracking pattern like (a+)+ would wedge SSR
 * for all staff. Rejected here ⇒ upsertSchema refuses it at write time.
 */
export function compileIdPattern(source: string): { ok: true; re: RegExp } | { ok: false; error: string } {
  const guard = idPatternGuard(source);
  if (!guard.ok) return guard;
  try {
    // Anchor it so it must match the WHOLE id (not a substring) when validating.
    const re = new RegExp(`^(?:${source})$`);
    return { ok: true, re };
  } catch (e) {
    return { ok: false, error: `idPattern is not a valid regex: ${(e as Error).message}` };
  }
}

/** True iff `id` matches the kind's anchored idPattern. */
export function idMatchesPattern(id: string, patternSource: string): boolean {
  const c = compileIdPattern(patternSource);
  return c.ok ? c.re.test(id) : false;
}

// ── Schema (kind) types ──────────────────────────────────────────────────────

export type CatalogKind = {
  id: number;
  kind: string;
  label: string;
  idPattern: string;
  schema: unknown;
  createdAt: Date;
  /** Number of items in this kind. */
  itemCount: number;
};

export type CatalogItemRow = {
  id: number;
  kind: string;
  itemId: string;
  title: string;
  body: string;
  status: string;
  data: unknown;
  sourceHash: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CatalogLinkEdge = {
  fromKind: string;
  fromItemId: string;
  toKind: string;
  toItemId: string;
  linkType: string;
};

// ── Schema reads ─────────────────────────────────────────────────────────────

/** All kinds, alphabetical by kind, each with an item count. */
export async function listKinds(): Promise<CatalogKind[]> {
  const rows = await db
    .select({
      id: catalogSchemas.id,
      kind: catalogSchemas.kind,
      label: catalogSchemas.label,
      idPattern: catalogSchemas.idPattern,
      schema: catalogSchemas.schema,
      createdAt: catalogSchemas.createdAt,
      itemCount: sql<number>`cast(count(${catalogItems.id}) as int)`,
    })
    .from(catalogSchemas)
    .leftJoin(catalogItems, eq(catalogItems.kind, catalogSchemas.kind))
    .groupBy(catalogSchemas.id)
    .orderBy(asc(catalogSchemas.kind));
  return rows.map((r) => ({ ...r }));
}

/** One kind by its slug, or null. */
export async function getSchema(kind: string): Promise<CatalogKind | null> {
  const all = await listKinds();
  return all.find((k) => k.kind === kind) ?? null;
}

// ── Schema writes ────────────────────────────────────────────────────────────

export type UpsertSchemaInput = {
  kind: string;
  label: string;
  idPattern: string;
  schema: unknown;
  actorName: string;
};

/**
 * Create or update a kind. Validates:
 *   - kind matches the slug pattern,
 *   - label non-empty,
 *   - idPattern compiles as a RegExp,
 *   - schema compiles as a JSON Schema (ajv).
 *
 * Additive vs breaking changes are NOT blocked (the spec: breaking changes are
 * flagged, not blocked) — the service applies the schema as given; the UI's
 * validation preview is what surfaces "would flag N items for migration".
 * Emits catalog.schema.created (new kind) or catalog.schema.updated.
 */
export async function upsertSchema(input: UpsertSchemaInput): Promise<CatalogResult<CatalogKind>> {
  const kind = input.kind.trim();
  if (!KIND_RE.test(kind)) return bad("kind must match ^[a-z0-9][a-z0-9-]*$", "invalid");
  const label = input.label.trim();
  if (label.length === 0) return bad("label must be non-empty", "invalid");

  const pat = compileIdPattern(input.idPattern);
  if (!pat.ok) return bad(pat.error, "invalid");

  const sch = compileSchema(input.schema);
  if (!sch.ok) return bad(sch.error, "invalid");

  return db.transaction(async (tx) => {
    const existing = await tx.query.catalogSchemas.findFirst({ where: eq(catalogSchemas.kind, kind) });
    if (existing) {
      await tx
        .update(catalogSchemas)
        .set({ label, idPattern: input.idPattern, schema: input.schema as object })
        .where(eq(catalogSchemas.kind, kind));
      await emitEvent(tx, {
        kind: "catalog.schema.updated",
        payload: { kind },
        actorName: input.actorName,
      });
    } else {
      await tx
        .insert(catalogSchemas)
        .values({ kind, label, idPattern: input.idPattern, schema: input.schema as object });
      await emitEvent(tx, {
        kind: "catalog.schema.created",
        payload: { kind },
        actorName: input.actorName,
      });
    }
    const row = (await getSchemaTx(tx, kind))!;
    return ok(row);
  });
}

async function getSchemaTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  kind: string,
): Promise<CatalogKind | null> {
  const rows = await tx
    .select({
      id: catalogSchemas.id,
      kind: catalogSchemas.kind,
      label: catalogSchemas.label,
      idPattern: catalogSchemas.idPattern,
      schema: catalogSchemas.schema,
      createdAt: catalogSchemas.createdAt,
      itemCount: sql<number>`cast(count(${catalogItems.id}) as int)`,
    })
    .from(catalogSchemas)
    .leftJoin(catalogItems, eq(catalogItems.kind, catalogSchemas.kind))
    .where(eq(catalogSchemas.kind, kind))
    .groupBy(catalogSchemas.id);
  return rows.length > 0 ? { ...rows[0] } : null;
}

/**
 * Delete a kind (admin). Refuses ("in-use") when any item still references it —
 * delete its items first. Emits catalog.schema.deleted.
 */
export async function deleteSchema(kind: string, actorName: string): Promise<CatalogResult<{ kind: string }>> {
  return db.transaction(async (tx) => {
    const existing = await tx.query.catalogSchemas.findFirst({ where: eq(catalogSchemas.kind, kind) });
    if (!existing) return bad("kind not found", "not-found");
    const [{ count }] = await tx
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(catalogItems)
      .where(eq(catalogItems.kind, kind));
    if (count > 0) return bad("kind has items — delete them first", "conflict");
    await tx.delete(catalogSchemas).where(eq(catalogSchemas.kind, kind));
    await emitEvent(tx, {
      kind: "catalog.schema.deleted",
      payload: { kind },
      actorName,
    });
    return ok({ kind });
  });
}

// ── Item reads ───────────────────────────────────────────────────────────────

function toItemRow(r: Record<string, unknown>): CatalogItemRow {
  return {
    id: r.id as number,
    kind: r.kind as string,
    itemId: r.itemId as string,
    title: r.title as string,
    body: r.body as string,
    status: r.status as string,
    data: r.data,
    sourceHash: (r.sourceHash as string | null) ?? null,
    createdAt: r.createdAt as Date,
    updatedAt: r.updatedAt as Date,
  };
}

export type ListItemsOpts = {
  kind: string;
  status?: string;
  /** ilike over itemId/title (simple substring — NOT full-text). */
  q?: string;
};

/**
 * List items for a kind, newest-updated first. `status` filters exactly; `q` is
 * a case-insensitive substring match over itemId OR title (kept deliberately
 * simple — not FTS).
 */
export async function listItems(opts: ListItemsOpts): Promise<CatalogItemRow[]> {
  const conds = [eq(catalogItems.kind, opts.kind)];
  if (opts.status != null && opts.status.trim().length > 0) {
    conds.push(eq(catalogItems.status, opts.status.trim()));
  }
  if (opts.q != null && opts.q.trim().length > 0) {
    const like = `%${opts.q.trim()}%`;
    conds.push(
      or(ilike(catalogItems.itemId, like), ilike(catalogItems.title, like))!,
    );
  }
  const rows = await db
    .select()
    .from(catalogItems)
    .where(and(...conds))
    .orderBy(desc(catalogItems.updatedAt), asc(catalogItems.itemId));
  return rows.map((r) => toItemRow(r as Record<string, unknown>));
}

export type ItemWithLinks = {
  item: CatalogItemRow;
  outbound: CatalogLinkEdge[];
  inbound: CatalogLinkEdge[];
};

/** One item plus its outbound + inbound typed links. Null if not found. */
export async function getItem(kind: string, itemId: string): Promise<ItemWithLinks | null> {
  const rows = await db
    .select()
    .from(catalogItems)
    .where(and(eq(catalogItems.kind, kind), eq(catalogItems.itemId, itemId)))
    .limit(1);
  if (rows.length === 0) return null;
  const item = toItemRow(rows[0] as Record<string, unknown>);

  const outRows = await db
    .select()
    .from(catalogLinks)
    .where(and(eq(catalogLinks.fromKind, kind), eq(catalogLinks.fromItemId, itemId)))
    .orderBy(asc(catalogLinks.linkType), asc(catalogLinks.toItemId));
  const inRows = await db
    .select()
    .from(catalogLinks)
    .where(and(eq(catalogLinks.toKind, kind), eq(catalogLinks.toItemId, itemId)))
    .orderBy(asc(catalogLinks.linkType), asc(catalogLinks.fromItemId));

  const toEdge = (r: typeof outRows[number]): CatalogLinkEdge => ({
    fromKind: r.fromKind,
    fromItemId: r.fromItemId,
    toKind: r.toKind,
    toItemId: r.toItemId,
    linkType: r.linkType,
  });

  return { item, outbound: outRows.map(toEdge), inbound: inRows.map(toEdge) };
}

// ── Link extraction ──────────────────────────────────────────────────────────

/**
 * Recursively collect every string leaf from a JSON value (the item `data`),
 * so link extraction scans data values too (not just the markdown body).
 */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value != null && typeof value === "object") {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
}

/**
 * Scan `body` + `data` for ids matching ANY kind's idPattern, returning the
 * derived outbound edges from (fromKind, fromItemId). Self-references are
 * excluded (an item linking to its own id is not an edge). The link type is
 * always "references" for derived links — explicit typed edges are set
 * separately. Patterns are matched GLOBALLY (so every occurrence is found) but
 * deduped to one edge per target.
 *
 * `kinds` = every registered { kind, idPattern }. We compile each pattern as a
 * global regex; a match's text IS the target itemId, and the matching pattern's
 * kind IS the target kind.
 */
export function extractLinks(
  fromKind: string,
  fromItemId: string,
  body: string,
  data: unknown,
  kinds: Array<{ kind: string; idPattern: string }>,
): CatalogLinkEdge[] {
  const haystacks: string[] = [body];
  collectStrings(data, haystacks);
  const text = haystacks.join("\n");

  const seen = new Set<string>(); // `${toKind} ${toItemId}`
  const edges: CatalogLinkEdge[] = [];

  for (const k of kinds) {
    // Defensive ReDoS skip: upsertSchema already rejects unsafe patterns, but
    // a pre-guard row in the DB must not be able to wedge link extraction.
    if (!idPatternGuard(k.idPattern).ok) continue;
    let re: RegExp;
    try {
      // Global, non-anchored: find every id occurrence inside the text. We wrap
      // the source so alternations stay grouped, and require a word-ish boundary
      // around it so `F-12` doesn't match inside `XF-123`.
      re = new RegExp(`(?<![\\w-])(?:${k.idPattern})(?![\\w-])`, "g");
    } catch {
      continue; // a bad pattern can't break the whole extraction
    }
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const toItemId = m[0];
      // Exclude a self-reference (same kind + same id).
      if (k.kind === fromKind && toItemId === fromItemId) continue;
      const key = `${k.kind} ${toItemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ fromKind, fromItemId, toKind: k.kind, toItemId, linkType: "references" });
      // Guard against zero-width matches looping forever.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return edges;
}

// ── Item writes ──────────────────────────────────────────────────────────────

export type UpsertItemInput = {
  kind: string;
  itemId: string;
  title: string;
  body?: string;
  status?: string;
  data?: unknown;
  sourceHash?: string | null;
  actorName: string;
};

/**
 * Upsert an item (create or update, keyed on (kind, itemId)). Validates:
 *   - the kind exists,
 *   - itemId matches the kind's anchored idPattern (CLIENT-PROPOSED id),
 *   - title non-empty, body within cap,
 *   - data validates against the kind's JSON Schema (ajv).
 *
 * On success, links are re-derived atomically: all existing DERIVED
 * ("references") outbound links from this item are deleted and replaced by the
 * freshly-scanned set, inside the same transaction. Explicit non-"references"
 * edges (set via setLink) are left untouched. Emits catalog.item.created or
 * catalog.item.updated (payload: kind/itemId/title/status only).
 */
export async function upsertItem(input: UpsertItemInput): Promise<CatalogResult<CatalogItemRow>> {
  const kind = input.kind.trim();
  const itemId = input.itemId.trim();
  if (itemId.length === 0) return bad("itemId must be non-empty", "invalid");
  const title = input.title.trim();
  if (title.length === 0) return bad("title must be non-empty", "invalid");
  const body = input.body ?? "";
  if (typeof body !== "string") return bad("body must be a string", "invalid");
  if (body.length > MAX_CATALOG_BODY_CHARS) {
    return bad(`body too long (max ${MAX_CATALOG_BODY_CHARS} chars)`, "invalid");
  }
  const status = (input.status ?? "").trim();
  const data = input.data ?? {};

  // Load the schema first (existence + pattern + data validation are all keyed
  // off it). Done outside the tx so a validation failure does no DB work.
  const schemaRow = await getSchema(kind);
  if (!schemaRow) return bad(`kind '${kind}' not found`, "not-found");

  if (!idMatchesPattern(itemId, schemaRow.idPattern)) {
    return bad(`itemId '${itemId}' does not match the kind's id pattern (${schemaRow.idPattern})`, "invalid");
  }

  const sch = compileSchema(schemaRow.schema);
  if (sch.ok) {
    const valid = sch.validate(data);
    if (!valid) {
      const msg = (sch.validate.errors ?? [])
        .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
        .join("; ");
      return bad(`data does not validate against the '${kind}' schema: ${msg}`, "invalid");
    }
  }
  // (If the stored schema somehow fails to compile we skip data validation
  // rather than block writes — schema upsert already guards compilation.)

  // Re-derive links against the CURRENT set of kinds.
  const kinds = (await listKinds()).map((k) => ({ kind: k.kind, idPattern: k.idPattern }));
  const derived = extractLinks(kind, itemId, body, data, kinds);

  return db.transaction(async (tx) => {
    const existing = await tx.query.catalogItems.findFirst({
      where: and(eq(catalogItems.kind, kind), eq(catalogItems.itemId, itemId)),
    });

    if (existing) {
      await tx
        .update(catalogItems)
        .set({
          title,
          body,
          status,
          data: data as object,
          sourceHash: input.sourceHash ?? existing.sourceHash ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(catalogItems.kind, kind), eq(catalogItems.itemId, itemId)));
    } else {
      await tx.insert(catalogItems).values({
        kind,
        itemId,
        title,
        body,
        status,
        data: data as object,
        sourceHash: input.sourceHash ?? null,
      });
    }

    // Atomic link replacement: drop existing DERIVED ('references') outbound
    // links from this item, re-insert the freshly-derived set. Explicit typed
    // edges (linkType <> 'references') survive.
    await tx
      .delete(catalogLinks)
      .where(
        and(
          eq(catalogLinks.fromKind, kind),
          eq(catalogLinks.fromItemId, itemId),
          eq(catalogLinks.linkType, "references"),
        ),
      );
    if (derived.length > 0) {
      await tx
        .insert(catalogLinks)
        .values(derived.map((e) => ({ ...e })))
        .onConflictDoNothing();
    }

    await emitEvent(tx, {
      kind: existing ? "catalog.item.updated" : "catalog.item.created",
      payload: { kind, itemId, title, status },
      actorName: input.actorName,
    });

    const row = (await tx
      .select()
      .from(catalogItems)
      .where(and(eq(catalogItems.kind, kind), eq(catalogItems.itemId, itemId)))
      .limit(1))[0];
    return ok(toItemRow(row as Record<string, unknown>));
  });
}

/**
 * Delete an item (admin). Cascades: removes every link where this item is the
 * `from` OR the `to` endpoint (so no dangling edges), in the same transaction.
 * Emits catalog.item.deleted. "not-found" if the item is unknown.
 */
export async function deleteItem(
  kind: string,
  itemId: string,
  actorName: string,
): Promise<CatalogResult<{ kind: string; itemId: string }>> {
  return db.transaction(async (tx) => {
    const existing = await tx.query.catalogItems.findFirst({
      where: and(eq(catalogItems.kind, kind), eq(catalogItems.itemId, itemId)),
    });
    if (!existing) return bad("item not found", "not-found");

    await tx
      .delete(catalogLinks)
      .where(
        or(
          and(eq(catalogLinks.fromKind, kind), eq(catalogLinks.fromItemId, itemId)),
          and(eq(catalogLinks.toKind, kind), eq(catalogLinks.toItemId, itemId)),
        ),
      );
    await tx
      .delete(catalogItems)
      .where(and(eq(catalogItems.kind, kind), eq(catalogItems.itemId, itemId)));

    await emitEvent(tx, {
      kind: "catalog.item.deleted",
      payload: { kind, itemId, title: existing.title, status: existing.status },
      actorName,
    });
    return ok({ kind, itemId });
  });
}

// ── Auto-link support ────────────────────────────────────────────────────────

/**
 * The active { kind, idPattern } set, for the renderer's auto-linker. Cheap
 * read; callers cache per request. Returned in a stable order (by kind) so the
 * matcher is deterministic.
 */
export async function listActivePatterns(): Promise<Array<{ kind: string; idPattern: string }>> {
  const rows = await db
    .select({ kind: catalogSchemas.kind, idPattern: catalogSchemas.idPattern })
    .from(catalogSchemas)
    .orderBy(asc(catalogSchemas.kind));
  return rows;
}
