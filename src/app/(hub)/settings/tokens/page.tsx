import { headers } from "next/headers";
import { getPrincipal } from "@/lib/auth";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import { listTokensForUser } from "@/lib/spaces";
import TokensClient, { type TokenRow } from "./TokensClient";

export const dynamic = "force-dynamic";

/**
 * /settings/tokens — the self-serve principal-token manager. This is the literal
 * answer to "how do I get a git push credential": mint a token (shown ONCE),
 * see your live + revoked tokens, revoke any. Staff-only (the layout already
 * gates anonymous); every token here is scoped to YOUR user.
 */
export default async function TokensPage() {
  const principal = await getPrincipal(await headers());
  // Layout blocks anonymous — principal is admin | member here.
  const userId = await resolvePrincipalUserId(principal);
  const tokens: TokenRow[] = userId == null ? [] : await projectTokens(userId);
  const resolvable = userId != null;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "32px 20px 80px" }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em", margin: "0 0 4px" }}>
        Tokens
      </h1>
      <p style={{ margin: "0 0 24px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
        A <strong>principal token</strong> is the credential a git client sends as
        its HTTP&nbsp;Basic password to clone or push a space over{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>/api/git/&lt;owner&gt;/&lt;space&gt;.git</span>.
        It is bound to your user and carries your role on each space. A token is
        shown <strong>once</strong> at mint time — store it then; Desk only keeps
        its hash.
      </p>
      <TokensClient initialTokens={tokens} resolvable={resolvable} />
    </div>
  );
}

async function projectTokens(userId: number): Promise<TokenRow[]> {
  const rows = await listTokensForUser(userId);
  return rows.map((t) => ({
    id: t.id,
    label: t.label,
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
    revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
  }));
}
