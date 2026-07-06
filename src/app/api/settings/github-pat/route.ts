/**
 * GET/POST/DELETE /api/settings/github-pat — the instance-level GitHub mirror
 * PAT (convergence fix-pass, Slice 4c; decision D-C5). ADMIN ONLY (there is no
 * per-space owner here — this is a deployment-wide secret, same posture as
 * `/api/users` admin gate: `principal.kind !== "admin"` → 403).
 *
 * WRITE-ONLY BY CONSTRUCTION: every response shape below carries a boolean
 * (`configured`) and NEVER the PAT value. `setInstanceGithubPat` /
 * `clearInstanceGithubPat` / `hasInstanceGithubPat` (src/lib/instance-settings.ts)
 * are the only calls this route makes — there is no decrypt-and-return path, and
 * the only function that DOES decrypt (`getInstanceGithubPat`) is never called
 * from a route, only from the mirror push itself.
 */
import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import {
  setInstanceGithubPat,
  clearInstanceGithubPat,
  hasInstanceGithubPat,
} from "@/lib/instance-settings";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

async function requireAdmin(req: Request) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (principal.kind !== "admin") return err(403, "Forbidden — admin only");
  return null;
}

/** { configured: boolean } — never the PAT. */
export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  return NextResponse.json({ configured: await hasInstanceGithubPat() });
}

/** Set/replace the PAT. Body: { pat: string }. Response: { ok, configured } — never the PAT. */
export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.pat !== "string" || b.pat.trim().length === 0) {
    return err(400, "Missing or invalid pat — must be a non-empty string");
  }

  const ok = await setInstanceGithubPat(b.pat);
  if (!ok) {
    return err(500, "DESK_TOKEN_KEY is not configured on this instance — cannot store the PAT");
  }
  return NextResponse.json({ ok: true, configured: true });
}

/** Clear the PAT. Response: { ok, configured: false }. */
export async function DELETE(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  await clearInstanceGithubPat();
  return NextResponse.json({ ok: true, configured: false });
}
