/**
 * The paste-able GLOBAL-SETUP PROMPT shown ONCE when a principal token is minted
 * (the raw token is only available at that moment). It is the productized version
 * of the manual fix `git config --global credential.helper store` + storing the
 * token for the host: a user pastes this prompt into a coding agent on their local
 * machine, and the agent configures git's credential-helper store so every future
 * clone/push to this Desk host authenticates automatically — no username/password
 * prompts.
 *
 * It is a PURE template — no I/O — so it is unit-testable directly, mirroring
 * `renderSetupPrompt` in src/lib/invites/setup-prompt.ts.
 *
 * The token is the HTTP Basic PASSWORD; the username is ignored by Desk's git
 * transport (see src/lib/git/auth.ts), so we store a fixed `git` username. The
 * `host=` line of the credential record must be the BARE host (scheme stripped,
 * path dropped) — that is what git matches against when it picks a stored
 * credential. We use the canonical idempotent `git credential approve` approach.
 *
 * SECURITY: the rendered string carries a LIVE credential. It is produced only at
 * mint time, in the just-minted UI where the raw token is shown once, with the
 * same lifecycle as the token itself. Callers must never persist or log it.
 */

export type TokenSetupPromptInput = {
  /** The git transport host base (scheme + host, no path, no trailing slash),
   *  e.g. "https://desk.example.com". The scheme is stripped for the
   *  credential `host=` line; the scheme also picks the `protocol=` value. */
  gitHostBase: string;
  /** The raw principal token (shown ONCE — same lifecycle as on mint). The HTTP
   *  Basic password Desk's transport authenticates against. */
  token: string;
};

/** Strip any trailing slash so the host base can be parsed safely. */
function noTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Split a host base into the pieces the credential record needs:
 *   - `protocol` — from the scheme (`https`|`http`), defaulting to `https`.
 *   - `host`     — the BARE host[:port], scheme stripped and any path dropped.
 * `"https://desk.example.com/"` → `{ protocol: "https", host: "desk.example.com" }`.
 * `"http://localhost:3000"`     → `{ protocol: "http",  host: "localhost:3000" }`.
 */
export function hostParts(gitHostBase: string): { protocol: string; host: string } {
  const base = noTrailingSlash(gitHostBase.trim());
  const m = /^(https?):\/\/(.+)$/i.exec(base);
  const protocol = m ? m[1].toLowerCase() : "https";
  const rest = m ? m[2] : base;
  // Keep only host[:port]; drop anything after the first path separator.
  const host = rest.split("/")[0];
  return { protocol, host };
}

/**
 * Render the global-setup prompt for a just-minted token. Returns a plain string
 * (the caller renders it in a copy-able code block): an agent-facing prose line
 * followed by a fenced shell block with the two idempotent commands.
 *
 * The fenced block carries the raw token in the `password=` field of the
 * `git credential approve` record; the trailing `\n` after `password=` is
 * required so git reads a complete record (a key=value line must be newline
 * terminated, and the record ends at EOF). Tokens are base64url, so they are safe
 * inside the single-quoted printf format.
 */
export function renderTokenSetupPrompt(input: TokenSetupPromptInput): string {
  const { protocol, host } = hostParts(input.gitHostBase);
  return [
    `Configure git to use this Desk token globally, so every clone/push to \`${host}\` authenticates automatically. The token is long-lived — this stores it once.`,
    "```",
    `git config --global credential.helper store`,
    `printf 'protocol=${protocol}\\nhost=${host}\\nusername=git\\npassword=${input.token}\\n' | git credential approve`,
    "```",
  ].join("\n");
}
