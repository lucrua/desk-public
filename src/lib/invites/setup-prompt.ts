/**
 * The paste-able SETUP PROMPT shown to an invited member (External Collaboration,
 * Slice E1). It is a pure template — no I/O — so it is unit-testable directly and
 * can render identically on the public accept page AND on the space page.
 *
 * The prompt tells an agent how to configure git with the invited member's token,
 * clone the space, read INSTRUCTIONS.md, and push. The PUSH LINE switches on the
 * space's `push_policy`:
 *   - `direct`   → `git push origin HEAD:main`
 *   - `proposal` → `git push origin HEAD:proposals/<handle>` (opens a PR for the owner)
 *
 * The clone URL is token-bearing: `https://<token>@<git-host>/api/git/<owner>/<space>.git`.
 * (The token is the HTTP Basic password; the username half is ignored by the git
 * transport — see src/lib/git/auth.ts.) The raw token appears here exactly once,
 * the same way it does on mint — the caller never persists the rendered prompt.
 *
 * SECURITY: the rendered string carries a LIVE credential. It is returned only on
 * the accept response (one-time) and re-rendered on the space page only for a
 * member who can already mint their own token — never to anonymous or to a
 * non-member. Callers must not log it.
 */
import type { SpacePushPolicy } from "@/lib/spaces";

export type SetupPromptInput = {
  /** The `<owner>` git-URL segment (the space owner's stable handle). */
  ownerSlug: string;
  /** The `<space>` git-URL segment (the space slug). */
  spaceSlug: string;
  /** The git transport host (scheme + host, no trailing slash, no path), e.g.
   *  "https://desk.example.com". Used to build the token-bearing clone URL. */
  gitHostBase: string;
  /** The raw principal token (shown ONCE — same lifecycle as on mint). */
  token: string;
  /** The space's push policy — switches the push line. */
  pushPolicy: SpacePushPolicy;
  /** The accepter's handle, used as the proposals/<handle> branch name in
   *  proposal mode. Falls back to "you" when absent/blank. */
  handle?: string | null;
};

/** Strip any trailing slash so the host base can be concatenated safely. */
function noTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * The token-bearing clone URL:
 *   `https://<token>@<git-host>/api/git/<owner>/<space>.git`
 * The token is the Basic-auth password; git accepts `<password>@host` (no user)
 * and our transport ignores the username, so this single-segment form works.
 */
export function tokenCloneUrl(input: {
  gitHostBase: string;
  token: string;
  ownerSlug: string;
  spaceSlug: string;
}): string {
  const base = noTrailingSlash(input.gitHostBase);
  // Split scheme from host so the token can be injected as the userinfo.
  const m = /^(https?:\/\/)(.+)$/i.exec(base);
  const scheme = m ? m[1] : "https://";
  const hostAndMaybePath = m ? m[2] : base;
  return `${scheme}${input.token}@${hostAndMaybePath}/api/git/${input.ownerSlug}/${input.spaceSlug}.git`;
}

/** The proposal-mode branch handle, sanitized to git-ref-safe characters. */
export function proposalHandle(handle: string | null | undefined): string {
  const raw = (handle ?? "").trim().toLowerCase();
  const seg = raw
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return seg.length > 0 ? seg : "you";
}

/**
 * Render the setup prompt for an invited member. Returns a plain string (the
 * caller renders it in a copy-able code block).
 */
export function renderSetupPrompt(input: SetupPromptInput): string {
  const cloneUrl = tokenCloneUrl({
    gitHostBase: input.gitHostBase,
    token: input.token,
    ownerSlug: input.ownerSlug,
    spaceSlug: input.spaceSlug,
  });

  const pushLine =
    input.pushPolicy === "proposal"
      ? `git push origin HEAD:proposals/${proposalHandle(input.handle)} # opens a PR for the owner to review`
      : `git push origin HEAD:main`;

  const spaceRef = `${input.ownerSlug}/${input.spaceSlug}`;

  return [
    `You have access to the Desk space \`${spaceRef}\`. Configure git to use this token, clone the space, read INSTRUCTIONS.md, do the work, then push.`,
    ``,
    `git clone ${cloneUrl}`,
    `cd ${input.spaceSlug}`,
    `# read INSTRUCTIONS.md, then do the work`,
    pushLine,
  ].join("\n");
}
