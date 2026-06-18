/**
 * Pure helpers for the /me page. No React / DOM / node imports so the masking
 * logic is unit-testable without rendering.
 */

/**
 * Mask a service-token Client ID for display: first 8 chars + "…". Tokens of 8
 * chars or fewer are shown whole (nothing to hide). Empty/absent → "—".
 */
export function maskToken(token: string | null | undefined): string {
  if (!token) return "—";
  return token.length > 8 ? token.slice(0, 8) + "…" : token;
}
