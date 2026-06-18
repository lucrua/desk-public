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
}
