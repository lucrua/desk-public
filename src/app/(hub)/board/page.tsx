import { headers } from "next/headers";
import { getPrincipal } from "@/lib/auth";
import { listBuckets } from "@/lib/buckets";
import { listCards } from "@/lib/cards";
import { listUsers } from "@/lib/users";
import BoardClient from "./BoardClient";
import type { BoardCard, BoardBucket } from "./view-model";

export const dynamic = "force-dynamic";

/**
 * The board surface. Staff-only (the layout already gates anonymous; the board
 * is internal — no audience scoping). The server loads buckets + every card
 * (live and archived) + the people list (for owner chips/filters), then hands
 * them to the client island which owns drag-and-drop, the drawer, menus, and
 * the per-column composer. Mutations go through /api/cards + /api/buckets; the
 * island re-fetches after each.
 */
export default async function BoardPage() {
  const principal = await getPrincipal(await headers());
  const isAdmin = principal.kind === "admin";

  const [buckets, cards, users] = await Promise.all([
    listBuckets(),
    listCards({ includeArchived: true }),
    listUsers(),
  ]);

  const boardBuckets: BoardBucket[] = buckets.map((b) => ({
    id: b.id,
    key: b.key,
    label: b.label,
    position: b.position,
  }));
  const boardCards: BoardCard[] = cards.map((c) => ({
    id: c.id,
    title: c.title,
    body: c.body,
    bucketId: c.bucketId,
    bucketKey: c.bucketKey,
    position: c.position,
    ownerUserId: c.ownerUserId,
    ownerName: c.ownerName,
    docSlug: c.docSlug,
    checklist: c.checklist,
    archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
  }));
  const people = users
    .filter((u) => u.active === 1)
    .map((u) => ({ id: u.id, name: u.displayName }));

  // The acting principal's own users-row id, so the island knows which cards a
  // member may edit (locked-card affordance). Resolve by email/tokenName the
  // same way the service does — but cheaply from the already-loaded list.
  let myUserId: number | null = null;
  if (principal.kind !== "anonymous") {
    const email = principal.email?.trim().toLowerCase();
    const tokenName = principal.tokenName?.trim();
    const me = users.find(
      (u) =>
        (email && u.email && u.email.toLowerCase() === email) ||
        (tokenName && u.tokenName && u.tokenName === tokenName),
    );
    myUserId = me?.id ?? null;
  }

  return (
    <BoardClient
      isAdmin={isAdmin}
      myUserId={myUserId}
      initialBuckets={boardBuckets}
      initialCards={boardCards}
      people={people}
    />
  );
}
