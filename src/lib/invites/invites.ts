/**
 * Space invites — the capability link that self-serves an EXTERNAL partner into a
 * space (External Collaboration, Slice E1). AUTH-SENSITIVE: an accepted invite
 * CREATES AN ACCOUNT and grants space membership, so it is the only door through
 * which an external (non-CF-Access) user enters Desk. Built fail-closed:
 *
 *   - The token is a capability: random 32-byte token, only its sha256 stored
 *     (raw shown once on mint — mirrors `shares` / `principal_tokens`).
 *   - Resolution is by tokenHash. EVERY failure cause — unknown / expired /
 *     over-maxUses / revoked — collapses to a UNIFORM 404 (the route renders one
 *     shape; no signal about which invite exists or why it failed).
 *   - Accept runs in ONE transaction: find-or-create the user (scoped to this one
 *     space), upsert the space_members row at the invite's role, bump `uses`
 *     (re-checking the cap inside the txn so two concurrent accepts can't exceed
 *     maxUses), and mint a principal token. NO EMAIL-EXISTENCE LEAK: the response
 *     is identical whether the email already had an account or not.
 *
 * The SHARE_BASE_URL invite link is `<base>/invite/<rawToken>`; the accept page +
 * its API live on the share host (CF-Access-bypassed) so an external recipient
 * can reach them — the link itself is the authorization.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { spaceInvites, spaceMembers, users, userEmails, principalTokens } from "@/db/schema";
import { mintToken, hashToken } from "@/lib/tokens";
import { emitEvent } from "@/lib/events";
import { getSpaceBySlug, ownerSlugForSpace } from "@/lib/spaces";
import { assignUserHandle } from "@/lib/user-handle";

const SHARE_BASE_URL = process.env.SHARE_BASE_URL ?? "http://localhost:3000";

/** Only writer|reader are invitable — ownership is never handed out via a link. */
export type InviteRole = "writer" | "reader";
export const INVITE_ROLES: InviteRole[] = ["writer", "reader"];

export type CreateInviteResult = {
  id: number;
  token: string;      // raw — appears exactly once, never persisted
  inviteUrl: string;  // <SHARE_BASE_URL>/invite/<rawToken>
  role: InviteRole;
  expiresAt: Date | null;
  maxUses: number;
};

export type CreateInviteOutcome =
  | ({ ok: true } & CreateInviteResult)
  | { ok: false; error: "unknown-space" | "invalid-role" | "invalid-max-uses" };

/** Normalize an optional target email: trim + lowercase; blank → undefined. */
function normalizeEmail(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  return v.length > 0 ? v : undefined;
}

/**
 * Create an invite for a space at a writer|reader role. The caller (route/MCP)
 * has already authorized owner-or-admin; this function does not re-check identity
 * authority, only validates inputs. Returns the one-time raw token + invite URL.
 *
 *   - expiresInDays: undefined = 7-day default; null = never; positive = N days.
 *   - maxUses: defaults to 1; must be a positive integer.
 *   - email: optional target (audit only — never restricts who may accept).
 */
export async function createInvite(opts: {
  spaceSlug: string;
  role: InviteRole;
  createdByUserId: number;
  email?: string | null;
  expiresInDays?: number | null;
  maxUses?: number;
  actorName: string;
}): Promise<CreateInviteOutcome> {
  if (!INVITE_ROLES.includes(opts.role)) return { ok: false, error: "invalid-role" };

  const maxUses = opts.maxUses ?? 1;
  if (!Number.isInteger(maxUses) || maxUses < 1) {
    return { ok: false, error: "invalid-max-uses" };
  }

  const space = await getSpaceBySlug(opts.spaceSlug);
  if (!space) return { ok: false, error: "unknown-space" };

  const token = mintToken();
  const tokenHash = hashToken(token);

  const expiresAt =
    opts.expiresInDays === null
      ? null
      : new Date(Date.now() + (opts.expiresInDays ?? 7) * 24 * 60 * 60 * 1000);

  const email = normalizeEmail(opts.email);

  const [inserted] = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(spaceInvites)
      .values({
        spaceId: space.id,
        role: opts.role,
        tokenHash,
        ...(email ? { email } : {}),
        createdByUserId: opts.createdByUserId,
        maxUses,
        ...(expiresAt !== null ? { expiresAt } : {}),
      })
      .returning();
    await emitEvent(tx, {
      kind: "space.invite_created",
      payload: { slug: space.slug, role: opts.role, inviteId: rows[0].id },
      actorName: opts.actorName,
    });
    return rows;
  });

  return {
    ok: true,
    id: inserted.id,
    token,
    inviteUrl: `${SHARE_BASE_URL}/invite/${token}`,
    role: opts.role,
    expiresAt,
    maxUses,
  };
}

export type ResolvedInvite = {
  inviteId: number;
  spaceId: number;
  spaceSlug: string;
  ownerSlug: string;
  role: InviteRole;
  email: string | null;
};

/**
 * Resolve an invite by its RAW token to a redeemable descriptor, or null on every
 * failure cause (unknown / expired / over-maxUses / revoked / blank). The caller
 * maps null → a UNIFORM 404. This is the read used by the accept page to render
 * "you're invited to <space> as <role>" — it never reveals WHY a bad token failed.
 *
 * NOTE: this is a READ-ONLY pre-check; the authoritative cap + expiry re-check
 * happens transactionally inside acceptInvite (so a race can't slip past maxUses).
 */
export async function resolveInvite(
  rawToken: string | null | undefined,
): Promise<ResolvedInvite | null> {
  if (!rawToken || rawToken.trim().length === 0) return null;
  const tokenHash = hashToken(rawToken.trim());

  const invite = await db.query.spaceInvites.findFirst({
    where: and(eq(spaceInvites.tokenHash, tokenHash), isNull(spaceInvites.revokedAt)),
  });
  if (!invite) return null;
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) return null;
  if (invite.uses >= invite.maxUses) return null;

  const spaceRow = await db.query.spaces.findFirst({
    where: (s, { eq: e }) => e(s.id, invite.spaceId),
  });
  if (!spaceRow) return null;
  const ownerSlug = await ownerSlugForSpace(spaceRow);

  return {
    inviteId: invite.id,
    spaceId: invite.spaceId,
    spaceSlug: spaceRow.slug,
    ownerSlug,
    role: invite.role as InviteRole,
    email: invite.email,
  };
}

export type AcceptInviteResult = {
  token: string;       // raw principal token — appears exactly once
  userId: number;
  spaceSlug: string;
  ownerSlug: string;
  role: InviteRole;
  /** A stable handle for the proposals/<handle> branch name in proposal mode. */
  handle: string;
};

export type AcceptInviteOutcome =
  | ({ ok: true } & AcceptInviteResult)
  | { ok: false; error: "not-found" | "invalid-email" };

/**
 * Accept an invite: find-or-create the user, grant space membership at the
 * invite's role, consume one use, and mint a principal token — ALL in one
 * transaction. Returns the raw principal token (once) + the clone-URL inputs.
 *
 * Fail-closed: a bad/expired/over-cap/revoked token → { ok:false, "not-found" }
 * (the route renders a UNIFORM 404). The maxUses cap + expiry are re-checked
 * INSIDE the transaction with a conditional UPDATE … WHERE uses < maxUses, so two
 * concurrent accepts cannot exceed the limit (the loser sees not-found).
 *
 * NO EMAIL-EXISTENCE LEAK: whether the email already had an account or not, the
 * outcome shape is identical; the caller's response never differs.
 */
export async function acceptInvite(
  rawToken: string | null | undefined,
  rawEmail: string,
): Promise<AcceptInviteOutcome> {
  if (!rawToken || rawToken.trim().length === 0) return { ok: false, error: "not-found" };
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: "invalid-email" };
  const tokenHash = hashToken(rawToken.trim());

  try {
    const txOut = await db.transaction(async (tx) => {
      // EXPIRY is checked in JS (not SQL `now()`): the columns are `timestamp
      // without time zone` and a non-UTC DB session timezone makes a stored Date
      // (UTC wall-clock) vs `now()::timestamp` (local wall-clock) comparison off
      // by the offset — the exact trap the `shares` resolution avoids by
      // comparing against `new Date()` in JS. We read the row, JS-check expiry/
      // revoked, THEN do the atomic conditional UPDATE for the USE-CAP (the
      // security-critical concurrency guard — `uses < maxUses` stays in SQL so two
      // concurrent accepts can't both win the last slot).
      const row = await tx.query.spaceInvites.findFirst({
        where: and(eq(spaceInvites.tokenHash, tokenHash), isNull(spaceInvites.revokedAt)),
      });
      if (!row) return { ok: false as const, error: "not-found" as const };
      if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
        return { ok: false as const, error: "not-found" as const };
      }

      // Atomically consume one use IFF still live + under the cap.
      const consumed = await tx
        .update(spaceInvites)
        .set({ uses: sql`${spaceInvites.uses} + 1` })
        .where(
          and(
            eq(spaceInvites.tokenHash, tokenHash),
            isNull(spaceInvites.revokedAt),
            sql`${spaceInvites.uses} < ${spaceInvites.maxUses}`,
          ),
        )
        .returning();
      if (consumed.length === 0) {
        // Over-cap (raced by a concurrent accept) — uniform not-found.
        return { ok: false as const, error: "not-found" as const };
      }
      const invite = consumed[0];

      const spaceRow = await tx.query.spaces.findFirst({
        where: (s, { eq: e }) => e(s.id, invite.spaceId),
      });
      if (!spaceRow) {
        // A space FK can't dangle, but fail closed defensively (rolls back the use).
        throw new Error("invite-space-missing");
      }

      // ── find-or-create the user by email (no existence leak either way) ──────
      // Look up via the user_emails index (any verified address resolves a user).
      const existingEmail = await tx.query.userEmails.findFirst({
        where: (ue, { eq: e }) => e(ue.email, email),
      });

      let userId: number;
      if (existingEmail) {
        userId = existingEmail.userId;
        // Reactivate a previously-offboarded account on re-accept (the invite is
        // a fresh grant of access — same as a new user).
        await tx.update(users).set({ active: 1 }).where(eq(users.id, userId));
      } else {
        const [created] = await tx
          .insert(users)
          .values({
            email,
            displayName: email,
            role: "member",
            active: 1,
          })
          .returning({ id: users.id });
        userId = created.id;
        // Mirror the primary email so future logins/lookups resolve this row.
        await tx.insert(userEmails).values({ userId, email });
        // Assign the stable owner handle atomically with the new user (S1).
        await assignUserHandle(tx, userId);
      }

      // ── upsert the space membership at the invite's role ─────────────────────
      const existingMember = await tx.query.spaceMembers.findFirst({
        where: and(
          eq(spaceMembers.spaceId, invite.spaceId),
          eq(spaceMembers.userId, userId),
        ),
      });
      // Never downgrade an existing owner; otherwise set to the invite's role.
      if (!existingMember) {
        await tx
          .insert(spaceMembers)
          .values({ spaceId: invite.spaceId, userId, role: invite.role })
          .onConflictDoNothing();
      } else if (existingMember.role !== "owner") {
        await tx
          .update(spaceMembers)
          .set({ role: invite.role })
          .where(
            and(eq(spaceMembers.spaceId, invite.spaceId), eq(spaceMembers.userId, userId)),
          );
      }

      await emitEvent(tx, {
        kind: "space.invite_accepted",
        payload: { slug: spaceRow.slug, role: invite.role, userId },
        actorName: email,
      });

      // ── mint the principal token (the git credential) ────────────────────────
      // Mint INSIDE the txn so a rollback (e.g. space-missing) leaves no token.
      const token = mintToken();
      const tokenHashPrincipal = hashToken(token);
      await tx.insert(principalTokens).values({
        userId,
        tokenHash: tokenHashPrincipal,
        label: `invite:${spaceRow.slug}`,
      });

      return {
        ok: true as const,
        token,
        userId,
        spaceRow,
        role: invite.role as InviteRole,
        handle: email.split("@")[0] ?? "you",
      };
    });

    if (!txOut.ok) return txOut;

    // Resolve the owner slug AFTER the transaction commits (a read on an
    // unrelated row — kept out of the txn so no nested non-tx query runs inside
    // the committed transaction).
    const ownerSlug = await ownerSlugForSpace(txOut.spaceRow);
    return {
      ok: true,
      token: txOut.token,
      userId: txOut.userId,
      spaceSlug: txOut.spaceRow.slug,
      ownerSlug,
      role: txOut.role,
      handle: txOut.handle,
    };
  } catch {
    // Any unexpected failure rolls back the whole accept (use, user, member,
    // token) and surfaces as a uniform not-found — fail closed, never leak.
    return { ok: false, error: "not-found" };
  }
}

/**
 * The git transport host base for the token-bearing clone URL. Prefers the git
 * remote base (HUB_BASE_URL — the host where /api/git/* is served), falling back
 * to the request origin, else localhost. Re-exported here so the route + page
 * share one resolution. (Distinct from SHARE_BASE_URL, which hosts the public
 * /invite/<token> page; the clone URL must point at the GIT transport.)
 */
export { gitRemoteBase as gitHostBase } from "@/lib/git-url";
