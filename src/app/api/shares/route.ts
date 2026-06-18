import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { createShare, createDirectoryShare, listShares } from "@/lib/shares";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err(400, "Invalid JSON body");
  }

  const b = body as Record<string, unknown>;
  const { docSlug, label, expiresInDays, pinnedVersionId } = b;

  // ── Directory mode: a pathPrefix (and no docSlug) ⇒ a folder share. ─────────
  if (b.pathPrefix !== undefined) {
    if (typeof b.pathPrefix !== "string" || b.pathPrefix.length === 0) {
      return err(400, "pathPrefix must be a non-empty string");
    }
    // label is optional — service auto-names from folder prefix when omitted
    const dirLabel = (typeof label === "string" && label.trim()) ? label.trim() : undefined;
    // expiresInDays: null or 0 = never; omit = 7d default; positive = that many days
    let dirExpiry: number | null | undefined;
    if (expiresInDays !== undefined) {
      if (expiresInDays === null || expiresInDays === 0) {
        dirExpiry = null; // never expire
      } else if (typeof expiresInDays !== "number" || !Number.isFinite(expiresInDays) || expiresInDays < 0) {
        return err(400, "expiresInDays must be a non-negative number or null");
      } else {
        dirExpiry = expiresInDays;
      }
    }
    const allowComments = b.allowComments === undefined ? true : b.allowComments === true;
    const result = await createDirectoryShare(
      b.pathPrefix,
      dirLabel,
      principal.name,
      dirExpiry,
      allowComments,
    );
    if (!result.ok) {
      // invalid-prefix covers both a bad path AND the disallowed root ('').
      return err(400, "Invalid folder — a non-empty, valid folder path is required (root is not allowed).");
    }
    return NextResponse.json({
      id: result.id,
      label: result.label,
      shareUrl: result.shareUrl,
      mode: "directory",
    });
  }

  if (!docSlug || typeof docSlug !== "string") {
    return err(400, "Missing or invalid docSlug — must be a non-empty string");
  }
  // label is optional — service auto-names from doc title when omitted
  const docLabel = (typeof label === "string" && label.trim()) ? label.trim() : undefined;
  // expiresInDays: null or 0 = never; omit = 7d default; positive = that many days
  let docExpiry: number | null | undefined;
  if (expiresInDays !== undefined) {
    if (expiresInDays === null || expiresInDays === 0) {
      docExpiry = null; // never expire
    } else if (typeof expiresInDays !== "number" || !Number.isFinite(expiresInDays) || expiresInDays < 0) {
      return err(400, "expiresInDays must be a non-negative number or null");
    } else {
      docExpiry = expiresInDays;
    }
  }
  let pinned: number | undefined;
  if (pinnedVersionId !== undefined && pinnedVersionId !== null) {
    if (typeof pinnedVersionId !== "number" || !Number.isInteger(pinnedVersionId) || pinnedVersionId <= 0) {
      return err(400, "pinnedVersionId must be a positive integer");
    }
    pinned = pinnedVersionId;
  }

  const result = await createShare(
    docSlug,
    docLabel,
    principal.name,
    docExpiry,
    pinned,
  );

  if (!result.ok) {
    if (result.error === "doc-not-found") {
      return err(404, `Doc '${docSlug}' not found`);
    }
    // pinned-version-not-found: the version doesn't belong to this doc.
    return err(400, "pinnedVersionId does not belong to this doc");
  }

  return NextResponse.json({
    id: result.id,
    label: result.label,
    shareUrl: result.shareUrl,
  });
}

export async function GET(req: Request) {
  const principal = await getPrincipal(req.headers);
  if (principal.kind !== "admin") {
    return err(403, "Forbidden — admin only");
  }

  const shares = await listShares();
  return NextResponse.json({ shares });
}
