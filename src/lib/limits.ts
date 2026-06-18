/**
 * Shared validation constants for doc publishing — used by both the REST
 * route (src/app/api/docs/route.ts) and the MCP tool registry so the two
 * surfaces can't drift apart.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_CONTENT_CHARS = 2_000_000;

/**
 * Max length of a single comment body (chars). Enforced by both the staff and
 * public (share-token) comment paths, the service layer, and the MCP tool —
 * shared here so the surfaces can't drift. Bodies arrive from the public
 * /api/s/[token]/comments path, so this is a storage-DoS guard as much as a UX
 * cap.
 */
export const MAX_COMMENT_CHARS = 10_000;

/**
 * Max length of a proposed-revision author note (chars). The revision content
 * itself reuses MAX_CONTENT_CHARS (it's a full doc body); the note is a short
 * "what I changed" annotation. Enforced by the service, the REST route, and the
 * MCP tool so the surfaces can't drift.
 */
export const MAX_REVISION_NOTE_CHARS = 1_000;

/**
 * Max length of a card body (markdown, chars). A card body is a short
 * coordination note — not a document — so it's capped well below a doc
 * (MAX_CONTENT_CHARS / 10). Enforced by the service, the REST routes, and the
 * MCP tools so the surfaces can't drift. Derived from MAX_CONTENT_CHARS so the
 * ratio stays explicit.
 */
export const MAX_CARD_BODY_CHARS = MAX_CONTENT_CHARS / 10;

/**
 * Max number of checklist items on a single card. A card checklist is a small
 * todo list, not a sub-board — capped to keep the jsonb payload bounded.
 */
export const MAX_CHECKLIST_ITEMS = 50;

/** Max length of a single checklist item's text (chars). */
export const MAX_CHECKLIST_ITEM_CHARS = 500;
