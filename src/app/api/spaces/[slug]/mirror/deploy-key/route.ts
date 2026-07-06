/**
 * POST/DELETE /api/spaces/[slug]/mirror/deploy-key — per-space GitHub mirror
 * deploy-key override (convergence fix-pass, Slice 4c; decision D-C5,
 * secondary to the instance PAT).
 *
 * `setSpaceDeployKey` / `clearSpaceDeployKey` / `hasSpaceDeployKey`
 * (src/lib/mirror.ts) already do the encryption + write-only enforcement —
 * this route ONLY validates input, applies the SAME owner/admin
 * `canManageSpace` gate every other mirror-settings route uses, and NEVER
 * echoes the key back. `hasSpaceDeployKey` (boolean-only, no reveal) is what a
 * settings page renders — it is not exposed as a GET here because the space
 * detail page already reads it server-side; adding a GET would just be a
 * second way to ask the same yes/no question with no new capability.
 *
 * Deploy-key GENERATION (server-side ed25519 keypair mint) is NOT implemented
 * here — seeding an OpenSSH-formatted private key from Node's `crypto` module
 * is fiddly enough that D-C5 already treats the deploy key as secondary to the
 * instance PAT. This is the documented paste-field fallback: an operator
 * generates the keypair themselves (e.g. `ssh-keygen -t ed25519 -f key -N ""`),
 * adds the PUBLIC half to the GitHub repo's Deploy Keys (write access), and
 * pastes the PRIVATE half here.
 */
import { NextResponse } from "next/server";
import { getPrincipal, isStaff } from "@/lib/auth";
import { canManageSpace, getSpaceBySlug } from "@/lib/spaces";
import { setSpaceDeployKey, clearSpaceDeployKey } from "@/lib/mirror";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<{ slug: string }> };

async function gate(req: Request, slug: string) {
  const principal = await getPrincipal(req.headers as unknown as Headers);
  if (!isStaff(principal)) return { ok: false as const, res: err(403, "Forbidden — staff only") };
  const space = await getSpaceBySlug(slug);
  if (!space) return { ok: false as const, res: err(404, "Not found") };
  if (!(await canManageSpace(principal, space))) {
    return {
      ok: false as const,
      res: err(403, "Forbidden — only an admin or the space owner can manage this space"),
    };
  }
  return { ok: true as const };
}

export async function POST(req: Request, { params }: RouteContext) {
  const { slug } = await params;
  const gated = await gate(req, slug);
  if (!gated.ok) return gated.res;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.privateKeyPem !== "string" || b.privateKeyPem.trim().length === 0) {
    return err(400, "Missing or invalid privateKeyPem — must be a non-empty string");
  }

  const ok = await setSpaceDeployKey(slug, b.privateKeyPem);
  if (!ok) {
    return err(500, "DESK_TOKEN_KEY is not configured on this instance — cannot store a deploy key");
  }
  return NextResponse.json({ ok: true, hasDeployKey: true });
}

export async function DELETE(req: Request, { params }: RouteContext) {
  const { slug } = await params;
  const gated = await gate(req, slug);
  if (!gated.ok) return gated.res;

  await clearSpaceDeployKey(slug);
  return NextResponse.json({ ok: true, hasDeployKey: false });
}
