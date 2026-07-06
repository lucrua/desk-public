/**
 * Instance-level settings — a tiny key→encrypted-value store for GLOBAL secrets
 * (convergence fix-pass, Slice 4b; decision D-C5). v1 holds exactly one secret:
 * the instance GitHub mirror PAT (a fine-grained Contents:Read/Write token) used
 * to authenticate the one-way mirror-out push for `hosted` spaces.
 *
 * WRITE-ONLY by policy. The plaintext is AES-256-GCM-encrypted at rest with
 * DESK_TOKEN_KEY (REUSING the existing crypto helper that powers share-token
 * reveal — never a bespoke cipher). The ONLY functions that return plaintext are
 * `getInstanceSecret` / `getInstanceGithubPat`, which are consumed EXCLUSIVELY by
 * the mirror push (`src/lib/mirror.ts`). No REST/MCP route ever calls them — a
 * settings UI only ever set/replace/clear/has, so the token can never be read
 * back through the API (same posture as a principal token / share token: shown
 * once, never revealed).
 *
 * When DESK_TOKEN_KEY is unset `encryptToken` returns null; `setInstanceSecret`
 * then REFUSES to store (returns false) rather than persisting a plaintext secret.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instanceSettings } from "@/db/schema";
import { encryptToken, decryptToken } from "@/lib/crypto";

/** The fixed key under which the instance GitHub mirror PAT is stored. */
export const INSTANCE_GITHUB_PAT_KEY = "github_mirror_pat";

/**
 * Set (or replace) an instance secret, encrypted at rest. Returns false WITHOUT
 * storing anything when DESK_TOKEN_KEY is unset/invalid (we never persist a
 * plaintext secret). Idempotent upsert on the key.
 */
export async function setInstanceSecret(key: string, raw: string): Promise<boolean> {
  const enc = encryptToken(raw);
  if (enc === null) return false; // no key → refuse to store plaintext
  await db
    .insert(instanceSettings)
    .values({ key, valueEnc: enc, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { valueEnc: enc, updatedAt: new Date() },
    });
  return true;
}

/** Clear an instance secret (idempotent — a no-op when absent). */
export async function clearInstanceSecret(key: string): Promise<void> {
  await db.delete(instanceSettings).where(eq(instanceSettings.key, key));
}

/** Whether an instance secret is set — WITHOUT revealing it (for the settings UI
 * to show "configured" vs "not configured"). */
export async function hasInstanceSecret(key: string): Promise<boolean> {
  const [row] = await db
    .select({ key: instanceSettings.key })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key))
    .limit(1);
  return row != null;
}

/**
 * INTERNAL — decrypt an instance secret to USE it. Returns null when absent, or
 * when DESK_TOKEN_KEY is unset/rotated (undecryptable). NOT for any API response;
 * the mirror push is the only caller.
 */
export async function getInstanceSecret(key: string): Promise<string | null> {
  const [row] = await db
    .select({ valueEnc: instanceSettings.valueEnc })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key))
    .limit(1);
  if (!row) return null;
  return decryptToken(row.valueEnc);
}

// ── GitHub mirror PAT — the fixed-key wrappers the settings UI (4c) will call ──

/** Set/replace the instance GitHub mirror PAT (write-only). false if no key. */
export function setInstanceGithubPat(raw: string): Promise<boolean> {
  return setInstanceSecret(INSTANCE_GITHUB_PAT_KEY, raw);
}

/** Clear the instance GitHub mirror PAT. */
export function clearInstanceGithubPat(): Promise<void> {
  return clearInstanceSecret(INSTANCE_GITHUB_PAT_KEY);
}

/** Whether an instance GitHub mirror PAT is configured (no reveal). */
export function hasInstanceGithubPat(): Promise<boolean> {
  return hasInstanceSecret(INSTANCE_GITHUB_PAT_KEY);
}

/** INTERNAL — the decrypted instance PAT, for the mirror push only. */
export function getInstanceGithubPat(): Promise<string | null> {
  return getInstanceSecret(INSTANCE_GITHUB_PAT_KEY);
}
