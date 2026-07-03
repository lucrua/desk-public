import { pgTable, serial, bigserial, text, timestamp, integer, doublePrecision, jsonb, pgEnum, uniqueIndex, customType, index, check, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Postgres `tsvector` — there is no built-in drizzle column type for it. The
// column is never written through drizzle's value path (it's maintained ON
// PUBLISH via raw SQL inside the publishDoc transaction); this type exists so
// the schema models the column and FTS queries can reference docs.searchTsv.
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const roleEnum = pgEnum("role", ["admin", "member"]);
export const formatEnum = pgEnum("doc_format", ["md", "html"]);

// ── Document-host (Phase 1) enums ────────────────────────────────────────────
// A space's listing visibility. PRIVATE is the only state that exists in
// Phase 1 (single owner-only space); `unlisted`/`public` are laid down now so
// Phase-2 multi-tenancy is purely additive. Visibility governs DISCOVERY only —
// it never relaxes the git-transport ACL, which is membership-driven and
// fail-closed (a private space is uniform-404 to non-members; see the git
// route). See specs/desk/design-document-host.md §14.
export const spaceVisibilityEnum = pgEnum("space_visibility", [
  "private",
  "unlisted",
  "public",
]);

// A principal's role WITHIN a space (the coarse, repo-grained WRITE boundary —
// §3). `reader` may clone/fetch (git-upload-pack); `writer` and `owner` may also
// push (git-receive-pack). Exactly one `owner` row exists per space (the space's
// ownerUserId, mirrored as a member row on create). Distinct from the global
// `role` enum (admin|member), which governs the hub app — a space role is local
// to one repo.
export const spaceRoleEnum = pgEnum("space_role", ["owner", "writer", "reader"]);

// A space's PUSH POLICY — the write boundary's branch-protection mode (External
// Collaboration, Slice E1; enforced in Slice E2). `direct` (the DEFAULT, and the
// only behaviour before this feature) lets every writer push the hosted `main`
// branch. `proposal` is the protected mode: a NON-OWNER writer's pushes to `main`
// are rejected (E2) and must go to `proposals/*`, surfacing as a PR the owner
// reviews. Owner/admin always push direct. In E1 the column + its UI exist and
// the setup-prompt template switches on it; the git-transport ENFORCEMENT is E2.
export const spacePushPolicyEnum = pgEnum("space_push_policy", ["direct", "proposal"]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").unique(),          // humans (CF-verified email) — PRIMARY/display email; every email (incl. this one) is mirrored into user_emails
  tokenName: text("token_name").unique(), // agents (CF service-token common name / dev token id)
  displayName: text("display_name").notNull(),
  role: roleEnum("role").notNull().default("member"),
  active: integer("active").notNull().default(1), // 1|0 — offboarding flips to 0
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Multiple emails per user. A user can own several CF-verified email addresses
// (lucas@example.org + lucas@example.net = one account); login by ANY of
// them resolves the same users row, same derived role. `email` is globally
// unique across ALL users — a given address belongs to exactly one user (no
// silent steal). The user's PRIMARY email (users.email) is ALSO mirrored here as
// a row, so the auth-resolution lookup is a single table (user_emails → userId →
// users). The migration backfills one row per existing users.email. Normalized
// (trim + lowercase) on store and lookup, matching the users.email convention.
export const userEmails = pgTable("user_emails", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  email: text("email").notNull().unique(), // normalized (trim + lowercase); globally unique
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("user_emails_user_idx").on(t.userId),
]);

// A verified-but-unknown visitor: passed the CF Access wall (JWT verifies, so
// they're already allowlisted) but has no users row yet. Upserted fire-and-forget
// from the auth layer; the admin approves (→ users row) or dismisses from the
// admin dashboard. Email-only (never service tokens).
export const accessRequests = pgTable("access_requests", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(), // normalized (trim + lowercase)
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  hits: integer("hits").notNull().default(1), // times this email has hit the wall unresolved
});

export const audiences = pgTable("audiences", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),       // ^[a-z0-9][a-z0-9-]*$ — the value stored on docs.audience
  label: text("label").notNull(),            // human-facing name, e.g. "Team", "PartnerCo"
  memberVisible: integer("member_visible").notNull().default(0), // 1|0 — members see docs in this audience
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Audience membership — the row that makes an audience a real GROUP. A user
// "belongs to" an audience; a doc tagged with that audience is visible to every
// member of the audience (PLUS everyone, when the audience's member_visible flag
// is on). One row per (audience, user); the unique index makes add idempotent at
// the DB layer. Both FKs cascade-irrelevant here (we delete memberships
// explicitly before deleting a user/audience), so plain references suffice.
export const audienceMembers = pgTable("audience_members", {
  id: serial("id").primaryKey(),
  audienceId: integer("audience_id").notNull().references(() => audiences.id),
  userId: integer("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("audience_members_uniq").on(t.audienceId, t.userId),
  index("audience_members_user_idx").on(t.userId),
]);

// ── Spaces (Phase-1 document host) ───────────────────────────────────────────
// A SPACE is an owned, access-controlled git repo that Desk hosts — the unit of
// write/clone access and the security boundary (§3). Truth = the bare repo on
// disk at <DATA_DIR>/spaces/<owner-slug>/<space-slug>.git; Desk's Postgres is a
// derived projection (§2). Phase 1 has a single owner-only space; the table is
// built so Phase-2 multi-tenancy is purely additive. `slug` is globally unique
// (Phase 1 single-owner; a Phase-2 migration may relax to per-owner uniqueness).
export const spaces = pgTable("spaces", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(), // ^[a-z0-9][a-z0-9-]*$ — the <space> path segment
  ownerUserId: integer("owner_user_id")
    .notNull()
    .references(() => users.id),
  visibility: spaceVisibilityEnum("visibility").notNull().default("private"),
  // The git-push branch-protection mode (External Collaboration, E1). `direct`
  // (default — preserves all pre-feature behaviour) lets writers push `main`;
  // `proposal` routes non-owner writer pushes to `proposals/*` (enforced in E2).
  // NOT NULL default 'direct' so every existing space keeps today's behaviour.
  pushPolicy: spacePushPolicyEnum("push_policy").notNull().default("direct"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Space membership — the coarse WRITE/clone ACL (§3). One row per (space, user)
// with a space-local role. The owner is ALSO mirrored as an `owner` member row
// on space creation, so the git auth middleware resolves access through this one
// table (token → user → space_members.role) without special-casing the owner.
// PK(spaceId, userId): a user holds at most one role per space. FAIL-CLOSED: no
// row = no access (uniform-404 on a private space).
export const spaceMembers = pgTable("space_members", {
  spaceId: integer("space_id")
    .notNull()
    .references(() => spaces.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  role: spaceRoleEnum("role").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.spaceId, t.userId] }),
  index("space_members_user_idx").on(t.userId),
]);

// Principal tokens — the credential for the git smart-HTTP transport (§13.5).
// The token is the Basic-auth PASSWORD (username ignored); it resolves to a
// users row, whose space_members role on the target space gates upload-pack /
// receive-pack. Only the sha256 HASH is stored — the raw token is shown once on
// mint and never recoverable (mirrors the `shares` capability-token model). A
// token belongs to exactly one user (human or agent/service principal).
// Revoking (revokedAt set) makes every git request with it fail-closed (404 on
// a private space). Distinct from CF-Access JWTs (the hub-app credential): this
// token authenticates the FILE transport, which CF Access does not gate.
export const principalTokens = pgTable("principal_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(), // sha256 hex — raw token never stored
  label: text("label").notNull(),                   // human-facing name ("agent CI", "Lucas laptop")
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("principal_tokens_user_idx").on(t.userId),
]);

// Space invites — a capability link that lets an EXTERNAL partner self-serve into
// a space (External Collaboration, Slice E1). An owner/admin mints an invite
// scoped to ONE space + a target role (writer|reader) + an expiry + a use-limit +
// (optionally) a target email. The accept flow is PUBLIC (on the share host,
// CF-Access-bypassed) — external recipients can't pass CF Access, so the invite
// LINK ITSELF is the authorization. Only the sha256 HASH of the token is stored
// (mirrors `shares` / `principal_tokens`): the raw token is shown ONCE on mint
// and at no other time. Resolution is by tokenHash; EVERY failure (unknown /
// expired / over-maxUses / revoked) collapses to a uniform 404 (no existence
// leak). Accepting: find-or-create the user, upsert a space_members row at the
// invite's role, bump `uses`, and mint a principal token — all in one
// transaction. ACCOUNT CREATION IS GATED BY A VALID INVITE: no invite, no
// account; the created user is scoped to this one space.
export const spaceInvites = pgTable("space_invites", {
  id: serial("id").primaryKey(),
  spaceId: integer("space_id")
    .notNull()
    .references(() => spaces.id),
  // The space role the accepter is granted. Only writer|reader are invitable —
  // ownership is never handed out via a link (owner transfer is out of scope).
  role: spaceRoleEnum("role").notNull(),
  tokenHash: text("token_hash").notNull().unique(), // sha256 hex — raw token never stored
  // Optional target email. When set, the invite is "intended for" this address
  // (surfaced to the owner); it does NOT restrict who may accept (the link is the
  // capability) and is NEVER used to confirm whether an email already has an
  // account (no existence leak). Normalized (trim + lowercase) on store.
  email: text("email"),
  createdByUserId: integer("created_by_user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at"),          // null = never expires
  maxUses: integer("max_uses").notNull().default(1),
  uses: integer("uses").notNull().default(0),
  // Soft-revoke (parity with shares/tokens): set ⇒ the link resolves to a
  // uniform 404 immediately, regardless of expiry/uses.
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("space_invites_space_idx").on(t.spaceId),
]);

export const docs = pgTable("docs", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  sourcePath: text("source_path").notNull(),   // e.g. os/CONTEXT.md — provenance stamp
  // VESTIGIAL (Gen-2 consolidation, migration 0016): read access is now
  // space-scoped (member of the doc's space, OR space.visibility public/unlisted,
  // OR a capability share) — `audience` no longer gates any read path. Made
  // NULLABLE so publish/projection need not supply it; the `audiences` /
  // `audience_members` tables are left dormant (dropped in a later cleanup slice).
  audience: text("audience"),
  // Implicit folder path: slash-joined segments, each ^[a-z0-9][a-z0-9-]*$, max
  // depth 6; '' = root. Organizational only — identity stays the slug, and
  // member visibility is audience-based (path is orthogonal). No folder entities.
  path: text("path").notNull().default(""),
  format: formatEnum("format").notNull().default("md"),
  currentVersionId: integer("current_version_id"), // FK intentionally omitted — avoids docs↔doc_versions circular reference
  unpublishedAt: timestamp("unpublished_at"),
  // Stage-2 tombstone. Set by deleteDoc — doc is gone from all surfaces.
  // Content is purged (doc_versions.content = '') but rows kept for FKs.
  deletedAt: timestamp("deleted_at"),
  // Weighted full-text vector: setweight(title,'A') || setweight(content,'B')
  // over the CURRENT version, maintained ON PUBLISH inside publishDoc's
  // transaction (and backfilled by migration 0006). GIN-indexed below.
  searchTsv: tsvector("search_tsv"),
  // Per-doc ownership (migration 0014). The creator's users.id — set on CREATE,
  // never changed on update. Nullable: existing docs stay null (admin-only
  // publish). Admins may reassign via setDocOwner. The owner may publish new
  // versions directly (no approval queue) and decide revisions on their doc.
  ownerUserId: integer("owner_user_id").references(() => users.id),
  // ── Document-host projection columns (Phase 1) ────────────────────────────
  // Every doc belongs to exactly one SPACE; its canonical bytes live in that
  // space's bare git repo at `path` (`sourcePath` is the repo-relative file
  // path). These columns make `docs` a PROJECTION INDEX of the repo (§14):
  //   - spaceId        the owning space (NOT NULL; backfilled to the imported
  //                    space by migration 0015 for pre-existing rows).
  //   - currentCommit  the git commit sha the projection was built from (the
  //                    space ref tip at index time). Null until first indexed.
  //   - renderedCache  the pre-rendered output (HTML/markdown) for the current
  //                    commit — refreshed by the indexer on push. Null = render
  //                    lazily / not yet built.
  //   - parsedFrontmatter  the doc's parsed YAML frontmatter (jsonb), or {} when
  //                    none. Feeds catalog/board projections (Phase 2).
  // contentHash already lives on doc_versions (the per-commit content fingerprint).
  spaceId: integer("space_id").notNull().references(() => spaces.id),
  currentCommit: text("current_commit"),
  renderedCache: text("rendered_cache"),
  parsedFrontmatter: jsonb("parsed_frontmatter").notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // PARTIAL unique index: only one LIVE doc may hold a given slug.
  // Deleted docs (deletedAt IS NOT NULL) are excluded, freeing the slug for reuse.
  // The slug is now a PERMANENT OPAQUE id (randomSlug), never derived from the
  // path — so this stays globally unique for free (see doc-identity spec).
  uniqueIndex("docs_slug_idx").on(t.slug).where(sql`${t.deletedAt} IS NULL`),
  // The PROJECTION-KEY lookup index: the indexer, tombstone, rename, file-view,
  // and create-guard all resolve a doc by (spaceId, sourcePath). NON-unique by
  // design — `sourcePath` is a provenance stamp (see the column comment), and
  // the legacy publish path may stamp the same path on more than one doc. The
  // collision FIX lives in the indexer keying on this pair + an opaque slug, not
  // in a DB constraint.
  index("docs_space_source_path_idx").on(t.spaceId, t.sourcePath),
  index("docs_search_tsv_idx").using("gin", t.searchTsv),
  index("docs_space_idx").on(t.spaceId),
]);

// TODO(P1+): add indexes on doc_versions.doc_id, share_views.share_id when query volume justifies
export const docVersions = pgTable("doc_versions", {
  id: serial("id").primaryKey(),
  docId: integer("doc_id").notNull().references(() => docs.id),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(), // sha256 hex of content
  publishedAt: timestamp("published_at").notNull().defaultNow(),
  publishedBy: text("published_by").notNull(), // principal display name
});

export const shares = pgTable("shares", {
  id: serial("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),     // sha256 hex — raw token never stored
  // AES-256-GCM ciphertext of the raw token, base64-encoded (iv.ct.tag).
  // Null for shares created before migration 0013 (unrecoverable — hash only).
  // Populated on every new share when DESK_TOKEN_KEY is set.
  tokenEnc: text("token_enc"),
  // A share is EITHER a doc share (docId set, pathPrefix null) OR a directory
  // share (pathPrefix set, docId null) — exactly one of the two is non-null,
  // enforced by a CHECK in migration 0011. docId was historically NOT NULL; it
  // is relaxed to nullable to admit directory shares.
  docId: integer("doc_id").references(() => docs.id),
  // Non-null on a DIRECTORY share: a normalized, non-empty folder path prefix
  // (e.g. "finance"). The share exposes every PUBLISHED doc whose path is the
  // prefix or under it (boundary-safe: path === prefix || startsWith(prefix+"/")).
  // Null on a doc share. Root ('') is disallowed at create — a root share would
  // expose everything.
  pathPrefix: text("path_prefix"),
  // The owning SPACE — the read-boundary scope (convergence fix-pass, Slice 1;
  // finding 3). A DIRECTORY share filters its docs by (path prefix AND this
  // space); without it, same-named folders in two spaces leak through one link.
  // REQUIRED for directory shares going forward (createDirectoryShare demands a
  // space). A DOC share derives its space from the doc, but carries it here too
  // for uniformity. Nullable at the column level only to admit the one-shot
  // backfill (backfillShareSpaceIds) of pre-migration rows; every live share
  // resolves fail-closed when it is null (an unscoped directory share is exactly
  // the leak, so it must NOT resolve).
  spaceId: integer("space_id").references(() => spaces.id),
  label: text("label").notNull(),              // "Pedro", "PartnerCo intro"
  createdBy: text("created_by").notNull(),
  allowComments: integer("allow_comments").notNull().default(1), // 1|0 — link visitors may comment
  // null = live (always resolves the doc's current version). Set = pinned: the
  // reader resolves this exact version regardless of later publishes. The
  // version must belong to this share's doc (validated on create).
  pinnedVersionId: integer("pinned_version_id").references(() => docVersions.id),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  // Stage-2 tombstone for a share link. Set by deleteShare. The row is KEPT
  // (share_views / comments FK it — hard-DELETE is forbidden). Deleted shares
  // are excluded from all admin lists; the link already 404s (revokedAt is set).
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("shares_token_idx").on(t.tokenHash),
  // Exactly one of (docId, pathPrefix) is non-null — a share is either a doc
  // share or a directory share, never both and never neither.
  check(
    "shares_doc_xor_prefix",
    sql`(${t.docId} is not null and ${t.pathPrefix} is null) or (${t.docId} is null and ${t.pathPrefix} is not null)`,
  ),
]);

export const shareViews = pgTable("share_views", {
  id: serial("id").primaryKey(),
  shareId: integer("share_id").notNull().references(() => shares.id),
  docVersionId: integer("doc_version_id").notNull().references(() => docVersions.id),
  viewedAt: timestamp("viewed_at").notNull().defaultNow(),
  ip: text("ip"),
  userAgent: text("user_agent"),
});

// Comments on a doc. Staff (admin/member) comment from the hub; share-link
// visitors comment from the public /s/[token] surface (shareId set, authorKind
// 'link:<label>'). `versionId` pins the comment to the doc version it was made
// against. `body` is markdown, capped at MAX_COMMENT_CHARS and always rendered
// through the escaped Markdown component (never a raw-HTML sink). authorName /
// authorKind are data → plain-text rendering only.
export const comments = pgTable("comments", {
  id: serial("id").primaryKey(),
  docId: integer("doc_id").notNull().references(() => docs.id),
  versionId: integer("version_id").notNull().references(() => docVersions.id),
  shareId: integer("share_id").references(() => shares.id), // set when posted via a share link
  authorName: text("author_name").notNull(),
  authorKind: text("author_kind").notNull(), // 'admin' | 'member' | 'link:<label>'
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// Proposed revisions to a doc (the web-editing loop). Staff propose an edit
// against the version they were reading (`baseVersionId`); the proposal queues
// as a `revisions` row with status 'open'. An admin reviews the unified diff
// and accepts (→ publishDoc creates a new immutable version, status 'accepted')
// or rejects (status 'rejected'). `content` is the full proposed doc body
// (markdown only — html docs get no editor), capped at MAX_CONTENT_CHARS. It is
// ALWAYS rendered through the escaped Markdown / diff text nodes downstream
// (never a raw-HTML sink). authorName / authorKind / note are data →
// plain-text rendering only.
export const revisions = pgTable("revisions", {
  id: serial("id").primaryKey(),
  docId: integer("doc_id").notNull().references(() => docs.id),
  baseVersionId: integer("base_version_id").notNull().references(() => docVersions.id),
  content: text("content").notNull(),
  authorName: text("author_name").notNull(),
  authorKind: text("author_kind").notNull(), // 'admin' | 'member'
  note: text("note"), // optional author note, capped at MAX_REVISION_NOTE_CHARS
  status: text("status").notNull().default("open"), // 'open' | 'accepted' | 'rejected'
  createdAt: timestamp("created_at").notNull().defaultNow(),
  decidedAt: timestamp("decided_at"),
});

// Kanban buckets — the board's columns, as data (not a hardcoded enum, the way
// audiences became data). Admin-CRUD; deletable only when empty. `key` is a
// stable slug (^[a-z0-9][a-z0-9-]*$) used in event payloads (from/to bucket
// keys) so consumers can filter `card.moved` without resolving ids. `position`
// is an integer column order (renumbered on reorder). Seeded with four generic
// buckets (Backlog / In Progress / Review / Done) in migration 0008.
export const buckets = pgTable("buckets", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(), // ^[a-z0-9][a-z0-9-]*$
  label: text("label").notNull(),
  position: integer("position").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Kanban cards — the live coordination truth. `position` is a fractional float
// for ordering WITHIN a bucket (insert between neighbors; renormalize on
// collision). `body` is markdown (capped at MAX_CARD_BODY_CHARS) rendered only
// through the escaped Markdown component. `checklist` is a jsonb array of
// {text, done} (≤ MAX_CHECKLIST_ITEMS). `ownerUserId` is the assignee (a users
// row, nullable). `docSlug` optionally links the card to a doc. `archivedAt`
// soft-archives. Every mutation emits a card.* event in-transaction; payloads
// carry ids + bucket keys, never the body.
export const cards = pgTable("cards", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  bucketId: integer("bucket_id")
    .notNull()
    .references(() => buckets.id),
  position: doublePrecision("position").notNull(),
  ownerUserId: integer("owner_user_id").references(() => users.id),
  docSlug: text("doc_slug"),
  checklist: jsonb("checklist").notNull().default([]), // [{text, done}]
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  archivedAt: timestamp("archived_at"),
}, (t) => [
  index("cards_bucket_idx").on(t.bucketId),
]);

// Catalog schemas — the "schema-as-data" registries (P3). Each row is a *kind*
// (e.g. finding, decision, rfc): a stable `kind` slug, a human `label`, an
// `idPattern` (a regex source string — e.g. `F-\d+` — used both to VALIDATE an
// item's human id and to AUTO-LINK occurrences of that id in doc/card bodies),
// and a JSON Schema (`schema`, jsonb) the item's structured `data` payload is
// validated against at write time. Schemas are editable via the API/UI — there
// is no redeploy; additive changes apply immediately, breaking changes are
// flagged (not blocked). Admin-CRUD; members read only. Mutations emit
// catalog.schema.* events in-transaction.
export const catalogSchemas = pgTable("catalog_schemas", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull().unique(), // ^[a-z0-9][a-z0-9-]*$
  label: text("label").notNull(),
  idPattern: text("id_pattern").notNull(), // regex SOURCE (anchored ^(…)$ when matching ids)
  schema: jsonb("schema").notNull().default({}), // JSON Schema for the item `data` payload
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Catalog items — the rows of a registry. `itemId` is the human id (e.g.
// "F-012"), unique per kind and validated against its kind's idPattern at write
// (the id is CLIENT-PROPOSED, server-validated — never minted server-side).
// `body` is markdown (capped at MAX_CARD_BODY_CHARS, same as a card — registries
// hold notes, not documents) rendered only through the escaped Markdown
// component. `data` is the jsonb payload validated against the kind's JSON
// Schema. `status` is free-text (the schema may constrain it via an enum, but
// the column is generic). `sourceHash` supports repo-mirror ingest (idempotent
// upsert when an external markdown file is re-synced). Mutations emit
// catalog.item.* events in-transaction (payload: kind/itemId/title/status only).
export const catalogItems = pgTable("catalog_items", {
  id: serial("id").primaryKey(),
  kind: text("kind")
    .notNull()
    .references(() => catalogSchemas.kind),
  itemId: text("item_id").notNull(), // human id, unique per kind
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  status: text("status").notNull().default(""),
  data: jsonb("data").notNull().default({}),
  sourceHash: text("source_hash"), // repo-mirror ingest cursor (nullable)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("catalog_items_kind_item_idx").on(t.kind, t.itemId),
  index("catalog_items_kind_idx").on(t.kind),
]);

// Catalog links — typed edges between catalog items (the cross-link graph).
// Derived at item-write time by scanning the item's body + data strings for
// OTHER kinds' idPatterns (and own-kind references, excluding the item itself),
// stored as `references` by default; explicit edges with other types
// (supersedes, implements, …) may also be set. A link is item↔item: from
// (fromKind, fromItemId) to (toKind, toItemId). Uniqueness on the full
// (from, to, type) tuple keeps re-derivation idempotent. Cascades when the
// owning item is deleted (handled in-service, not via DB cascade, so the event
// log and link cleanup stay transactional).
export const catalogLinks = pgTable("catalog_links", {
  id: serial("id").primaryKey(),
  fromKind: text("from_kind").notNull(),
  fromItemId: text("from_item_id").notNull(),
  toKind: text("to_kind").notNull(),
  toItemId: text("to_item_id").notNull(),
  linkType: text("link_type").notNull().default("references"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("catalog_links_edge_idx").on(
    t.fromKind,
    t.fromItemId,
    t.toKind,
    t.toItemId,
    t.linkType,
  ),
  index("catalog_links_from_idx").on(t.fromKind, t.fromItemId),
  index("catalog_links_to_idx").on(t.toKind, t.toItemId),
]);

// The append-only event log — the sync change-cursor and observability spine.
// Every mutation that matters appends an event row IN THE SAME db.transaction as
// the mutation (so a rolled-back mutation emits nothing). `id` is the monotonic
// cursor consumers page on (no client clocks). Payloads carry ids/slugs/buckets
// only — never document content; consumers fetch the body through the normal
// scoped read paths. S1 kinds: doc.published, doc.unpublished, doc.moved,
// revision.proposed, revision.decided, comment.added, user.approved. P2 board
// kinds: card.created, card.moved, card.updated, card.assigned, card.archived,
// bucket.created, bucket.updated, bucket.deleted.
export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull(),
  // docId is denormalized out of the payload so GET /api/events can audience-
  // scope doc-related events with a single join (null for non-doc events like
  // user.approved). It is NOT a FK: events outlive the rows they reference
  // (a doc can be hard-deleted later; the event log must survive).
  docId: integer("doc_id"),
  payload: jsonb("payload").notNull(),
  actorName: text("actor_name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
