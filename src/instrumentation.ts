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

  // Convergence fix-pass, Slice 4a: materialize legacy DB-only docs into git.
  // Pre-Slice-2 docs (created by the retired DB-direct publishDoc) have no blob
  // at `main` in their space repo — invisible to a clone / the Slice-4 GitHub
  // mirror. This commits each such doc's current content into its repo so git is
  // complete. Idempotent (only fills a MISSING blob; never overwrites git),
  // cheap on a materialized instance (one tree read per space), and best-effort
  // (a failure logs, never crashes boot).
  try {
    const { materializeDbOnlyDocs } = await import("@/lib/materialize");
    const r = await materializeDbOnlyDocs();
    if (r.docsMaterialized > 0 || r.collisions > 0 || r.errors > 0) {
      console.log(
        `[startup] materialized ${r.docsMaterialized} DB-only doc(s) into git across ${r.spacesCommitted} space(s)` +
          (r.collisions > 0 ? `; ${r.collisions} sourcePath collision(s) skipped` : "") +
          (r.errors > 0 ? `; ${r.errors} space(s) failed` : ""),
      );
    }
  } catch (e) {
    console.error("[startup] DB-only doc materialization failed:", (e as Error)?.message);
  }

  // Owner-namespace, Slice S1 (decision D1): backfill users.handle — the stable,
  // unique, URL-safe owner identity later slices use for repo paths + URLs. For
  // each user with a NULL handle, in deterministic id-ascending order, derive a
  // base (tokenName/email-local/`u<id>`), slugify, and de-dup with a `-N` suffix.
  // Idempotent (a user with a handle is skipped; a re-run is a no-op) +
  // best-effort (a failure logs, never crashes boot). Runs AFTER the backfills
  // above by convention (order-independent — it only touches users.handle).
  try {
    const { backfillUserHandles } = await import("@/lib/user-handle");
    await backfillUserHandles();
  } catch (e) {
    console.error("[startup] user handle backfill failed:", (e as Error)?.message);
  }
}
