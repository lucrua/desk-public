import { NextResponse } from "next/server";
import pkg from "../../../../package.json";

/**
 * GET /api/health — unauthenticated liveness probe. No auth, no DB, no data:
 * just `{ ok: true, version }` so Coolify healthchecks and deploy watchers can
 * tell the app is up without racing the boot or needing a CF service token.
 *
 * `version` is the package.json version (build-time constant). Deliberately
 * trivial — this must answer even when the DB is unreachable, so it touches
 * nothing but the process itself.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, version: pkg.version });
}
