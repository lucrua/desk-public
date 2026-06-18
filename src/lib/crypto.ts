/**
 * At-rest token encryption for share links.
 *
 * Uses AES-256-GCM keyed from `DESK_TOKEN_KEY` (32 bytes, base64 or hex).
 * When the key is unset, `encryptToken` returns null (feature degrades
 * gracefully — no crash, no token_enc stored, "copy" unavailable). The raw
 * token is still hashed and share resolution continues to work normally.
 *
 * Security note: a DB-leak AND app-key-leak together expose stored tokens.
 * Accepted tradeoff: the alternative (one-time tokens with no retrieval) was
 * rejected in favour of admin UX (re-copy any live link). See spec §Decisions.
 *
 * Key rotation note: rotating DESK_TOKEN_KEY makes existing token_enc rows
 * undecryptable (decryptToken returns null → "copy" shows unavailable).
 * The links themselves continue to work (hash lookup is unaffected).
 *
 * ## Env var: DESK_TOKEN_KEY
 *
 * Required to enable link-retrieval / copy. Generate with:
 *   openssl rand -base64 32
 * and set in .env.local (dev) or Coolify prod environment.
 * The value is either 32 raw bytes as base64 (44 chars), or 32 bytes as hex
 * (64 chars). Any other format is rejected and the key is treated as absent.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;   // 96-bit IV (GCM standard)
const TAG_BYTES = 16;  // 128-bit auth tag (GCM default)

/** Load and validate the 32-byte key from DESK_TOKEN_KEY, or return null. */
function loadKey(): Buffer | null {
  const raw = process.env.DESK_TOKEN_KEY;
  if (!raw) return null;

  const trimmed = raw.trim();

  // Try base64 (32 bytes → 44 chars with padding, or 43 without)
  if (trimmed.length >= 43 && trimmed.length <= 44) {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === 32) return buf;
  }

  // Try hex (32 bytes → 64 chars)
  if (trimmed.length === 64 && /^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, "hex");
    if (buf.length === 32) return buf;
  }

  return null;
}

/**
 * Encrypt a raw share token with AES-256-GCM.
 *
 * Output format: `<iv_b64>.<ct_b64>.<tag_b64>` — three dot-separated
 * base64url segments. Returns null when DESK_TOKEN_KEY is unset or invalid
 * (never throws — callers treat null as "copy unavailable").
 */
export function encryptToken(raw: string): string | null {
  const key = loadKey();
  if (key === null) return null;

  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const ptBuf = Buffer.from(raw, "utf8");
    const ctBuf = Buffer.concat([cipher.update(ptBuf), cipher.final()]);
    const tag = cipher.getAuthTag();

    const ivB64 = iv.toString("base64url");
    const ctB64 = ctBuf.toString("base64url");
    const tagB64 = tag.toString("base64url");
    return `${ivB64}.${ctB64}.${tagB64}`;
  } catch {
    return null;
  }
}

/**
 * Decrypt a token_enc value produced by encryptToken.
 *
 * Returns the original raw token on success, or null on any failure (bad key,
 * wrong key, tampered ciphertext, missing env var, malformed format).
 * Never throws to the caller.
 */
export function decryptToken(enc: string): string | null {
  const key = loadKey();
  if (key === null) return null;

  try {
    const parts = enc.split(".");
    if (parts.length !== 3) return null;
    const [ivB64, ctB64, tagB64] = parts;

    const iv = Buffer.from(ivB64, "base64url");
    const ct = Buffer.from(ctB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");

    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;

    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);

    const ptBuf = Buffer.concat([decipher.update(ct), decipher.final()]);
    return ptBuf.toString("utf8");
  } catch {
    return null;
  }
}
