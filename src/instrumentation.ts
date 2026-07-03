/**
 * Next.js instrumentation hook — runs once per server process on startup.
 * Reference: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Used for the admin-model-v2 transitional backfill: if ADMIN_EMAIL is set,
 * `ensureBootstrapAdmin` idempotently promotes that email's user to role='admin'.
 * This preserves the current admin during the deploy that flips role derivation
 * from ADMIN_EMAIL → stored column. Remove ADMIN_EMAIL from the environment
 * after the first post-upgrade deploy confirms the admin can still reach /admin.
 */
export async function register(): Promise<void> {
  // Only run server-side (not during the Next.js Edge Runtime or client builds).
  if (process.env.NEXT_RUNTIME === "edge") return;

  // Dynamic import keeps this out of the client bundle and avoids DB
  // connections during static-analysis / build time.
  const { ensureBootstrapAdmin } = await import("@/lib/auth/cloudflare");
  await ensureBootstrapAdmin();

  // External Collaboration E2: backfill the push-policy pre-receive hook onto
  // every EXISTING bare repo. Spaces created before E2 have no policy hook;
  // this sweep installs it so the git write boundary is enforced regardless of
  // when a space was created. Idempotent + best-effort (a failure logs, never
  // crashes boot).
  try {
    const { backfillPolicyHooks } = await import("@/lib/git/repo");
    const n = await backfillPolicyHooks();
    if (n > 0) console.log(`[startup] backfilled push-policy hook onto ${n} repo(s)`);
  } catch (e) {
    console.error("[startup] push-policy hook backfill failed:", (e as Error)?.message);
  }

  // Convergence fix-pass, Slice 1: backfill shares.space_id on pre-migration
  // rows so every directory share is space-scoped (finding 3). Doc shares take
  // the doc's space; ambiguous/empty directory shares are revoked (fail-closed,
  // D-C7). Idempotent + best-effort (a failure logs, never crashes boot).
  try {
    const { backfillShareSpaceIds } = await import("@/lib/shares");
    const r = await backfillShareSpaceIds();
    if (r.docFilled > 0 || r.dirFilled > 0 || r.dirRevoked > 0) {
      console.log(
        `[startup] share space_id backfill: ${r.docFilled} doc + ${r.dirFilled} dir filled, ${r.dirRevoked} dir revoked (ambiguous/empty)`,
      );
    }
  } catch (e) {
    console.error("[startup] share space_id backfill failed:", (e as Error)?.message);
  }
}
