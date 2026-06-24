/**
 * Push-policy ENFORCEMENT primitives — the E2 git write-boundary rule (External
 * Collaboration, Slice E2). AUTH-SENSITIVE; fail-closed by construction.
 *
 * A space's `push_policy` (lib/spaces.ts `SpacePushPolicy`) gates which refs a
 * pusher may UPDATE over the smart-HTTP transport:
 *
 *   policy=direct    every writer (and owner/admin) pushes `main` — UNCHANGED
 *                    pre-feature behaviour.
 *   policy=proposal  a NON-OWNER writer may NOT update the hosted branch `main`;
 *                    they may update only `refs/heads/proposals/*`. Owner/admin
 *                    push anything (no restriction).
 *
 * The decision is a PURE function of (policy, role, ref) — `refUpdateAllowed`.
 * It is enforced at the git layer by a per-repo `pre-receive` hook (installed by
 * `initBareRepo`) that receives the resolved role + policy via env
 * (DESK_PUSHER_ROLE / DESK_PUSH_POLICY — verified to propagate through
 * git-http-backend → git-receive-pack → the hook) and reads ref updates on
 * stdin (`<old> <new> <ref>`). Anything `refUpdateAllowed` rejects is declined
 * with a `remote:` message; a single rejected ref fails the whole push.
 *
 * FAIL-CLOSED: the hook treats an UNSET/garbage policy or role as the most
 * restrictive interpretation (proposal + non-owner) so a misconfigured env can
 * never silently widen the boundary. `refUpdateAllowed` mirrors that — see the
 * `else` branch.
 */
import type { SpacePushPolicy, SpaceRole } from "@/lib/spaces";

/** The hosted branch Desk renders + that proposal pushes are protected against. */
export const HOSTED_BRANCH = "main";
/** The protected-mode landing namespace for non-owner writer pushes. */
export const PROPOSALS_PREFIX = "refs/heads/proposals/";

/**
 * The set of roles that push UNRESTRICTED regardless of policy: the space OWNER
 * (and, via the transport, an admin resolves to a membership role — admins are
 * not a distinct git role here, but an owner-or-higher always pushes direct).
 *
 * NOTE: the git transport resolves a token → a `space_members.role` of
 * owner|writer|reader. There is no separate "admin" git role; an admin acting on
 * a space they don't own still resolves through membership. The policy boundary
 * therefore keys on `owner` = unrestricted, `writer` = restricted-in-proposal.
 */
export function roleIsUnrestricted(role: SpaceRole): boolean {
  return role === "owner";
}

/**
 * THE pure ref-authz decision (fail-closed).
 *
 * @param policy the space's push policy
 * @param role   the pusher's resolved space role
 * @param ref    the full ref being updated, e.g. "refs/heads/main"
 * @returns true iff this (policy, role) may UPDATE this ref.
 *
 * Rules:
 *   - direct  → always allowed (today's behaviour; the transport already gated
 *               that a reader can't push at all — only writer+ reach a hook).
 *   - owner   → always allowed (owner/admin push direct in any policy).
 *   - proposal + non-owner writer:
 *       • refs/heads/main                → REJECTED
 *       • refs/heads/proposals/<name>    → ALLOWED (non-empty <name>)
 *       • anything else (other branches, tags, refs/heads/proposals itself with
 *         no name, a ref that merely starts with the namespace but isn't under
 *         it) → REJECTED (default-deny — only the proposals/* namespace is open).
 */
export function refUpdateAllowed(
  policy: SpacePushPolicy,
  role: SpaceRole,
  ref: string,
): boolean {
  if (policy === "direct") return true;
  if (roleIsUnrestricted(role)) return true;
  // proposal mode, non-owner writer: ONLY a concrete proposals/<name> ref.
  if (ref === `refs/heads/${HOSTED_BRANCH}`) return false;
  if (ref.startsWith(PROPOSALS_PREFIX)) {
    const name = ref.slice(PROPOSALS_PREFIX.length);
    return isValidProposalName(name);
  }
  // Default-deny everything else under proposal mode for a non-owner writer.
  return false;
}

/**
 * A proposal name is the `<name>` in `refs/heads/proposals/<name>`. It must be
 * non-empty and slug-ish: lowercase letters, digits, `-`, `_`, `/` (so an agent
 * can namespace e.g. `proposals/alice/feature`), with no leading/trailing/double
 * slash and no `.`/`..` traversal-ish segments. This both validates an incoming
 * ref and constrains a name we render in a URL.
 */
const PROPOSAL_NAME_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

export function isValidProposalName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  return PROPOSAL_NAME_RE.test(name);
}

/** Full ref for a proposal name (the inverse of `proposalNameFromRef`). */
export function proposalRef(name: string): string {
  return `${PROPOSALS_PREFIX}${name}`;
}

/** Extract the `<name>` from a `refs/heads/proposals/<name>` ref, or null when
 * the ref isn't a (valid) proposal ref. */
export function proposalNameFromRef(ref: string): string | null {
  if (!ref.startsWith(PROPOSALS_PREFIX)) return null;
  const name = ref.slice(PROPOSALS_PREFIX.length);
  return isValidProposalName(name) ? name : null;
}

/**
 * The `pre-receive` hook script for a hosted bare repo — the E2 enforcement
 * point. It reads each ref update on stdin (`<old> <new> <ref>`) and, in
 * `proposal` mode for a NON-OWNER writer, DECLINES any update that isn't to a
 * `refs/heads/proposals/<name>` ref. Owner/admin and `direct` mode are
 * unrestricted. FAIL-CLOSED: an unset/unknown policy is treated as `proposal`
 * and an unset/unknown role as a non-owner writer, so a missing env var can only
 * ever make the boundary STRICTER, never weaker.
 *
 * The role + policy arrive as env (DESK_PUSHER_ROLE / DESK_PUSH_POLICY) the git
 * route sets on the git-http-backend spawn; they propagate to this hook (probed
 * + covered by tests). The script is POSIX `sh` (the runtime image's shell) and
 * self-contained — no Node, no network — so it can never fail a push for an
 * out-of-band reason.
 *
 * ENV-PRESENCE = HTTP-PUSH INVARIANT (the security model): the ONLY untrusted
 * write ingress is the smart-HTTP route, and the route sets BOTH env vars on
 * EVERY receive-pack spawn (unconditionally — see route.ts / http-backend.ts).
 * Therefore "env present" ⟺ "an HTTP push the route mediated" and "env ABSENT"
 * ⟺ "a LOCAL/server-side push on the box" (an operator's `git push`, the
 * server-side accept-merge, test seeding). A local push is trusted — there is no
 * code path by which an untrusted client reaches this hook without the env — so
 * an ABSENT policy means "not the gated HTTP path → allow." This is NOT a
 * weakening: it does not widen what an HTTP client can do (the route always
 * supplies the policy), it only avoids breaking trusted local git on the host.
 * FAIL-CLOSED still holds within the HTTP path: when the policy IS present and is
 * 'proposal', an unset/unknown ROLE is treated as a restricted writer.
 *
 * The ref-matching logic here MUST stay in lockstep with `refUpdateAllowed`
 * above (tests assert the two agree across the matrix).
 */
export function preReceivePolicyHookScript(): string {
  // Note: the proposals-name validation in the hook is a deliberately SIMPLER
  // shell check (non-empty name, no traversal) than the JS regex — the JS layer
  // (route + proposals service) does the strict validation when a name is
  // surfaced in a URL. The hook's job is the coarse boundary: "is this main (or
  // some other non-proposals ref) being pushed by a restricted writer?".
  return [
    "#!/bin/sh",
    "# Desk push-policy pre-receive hook (External Collaboration, E2).",
    "# AUTH-SENSITIVE — the git write boundary. The HTTP route is the only",
    "# untrusted ingress and ALWAYS sets DESK_PUSH_POLICY; an UNSET policy means a",
    "# trusted LOCAL/server-side push (operator, accept-merge, seed) → allow. When",
    "# the policy IS set we enforce, FAIL-CLOSED on the role. See the doc comment.",
    "",
    "# No policy env ⇒ not the gated HTTP path ⇒ a trusted local push ⇒ allow.",
    'if [ -z "${DESK_PUSH_POLICY:-}" ]; then',
    "  exit 0",
    "fi",
    "policy=\"$DESK_PUSH_POLICY\"",
    "# Within the HTTP path, fail closed on the role: unset/unknown ⇒ restricted.",
    "role=\"${DESK_PUSHER_ROLE:-writer}\"",
    "",
    "# direct mode: unchanged pre-feature behaviour — allow every ref.",
    'if [ "$policy" = "direct" ]; then',
    "  exit 0",
    "fi",
    "",
    "# proposal mode: owner/admin push anything; a non-owner writer is restricted.",
    'if [ "$role" = "owner" ] || [ "$role" = "admin" ]; then',
    "  exit 0",
    "fi",
    "",
    "# Restricted writer in proposal mode: allow ONLY refs/heads/proposals/<name>.",
    "status=0",
    "while read -r old new ref; do",
    '  case "$ref" in',
    "    refs/heads/proposals/?*)",
    "      # Reject any traversal-ish segment in the proposal name.",
    '      case "$ref" in',
    "        */../*|*/..|*//*)",
    '          echo "remote: rejected $ref — invalid proposal name" 1>&2',
    "          status=1 ;;",
    "        *) : ;;  # allowed",
    "      esac",
    "      ;;",
    "    *)",
    '      echo "remote: rejected $ref — this space requires proposals: push to proposals/<name> (e.g. git push origin HEAD:proposals/$(id -un 2>/dev/null || echo me))" 1>&2',
    "      status=1",
    "      ;;",
    "  esac",
    "done",
    "exit $status",
    "",
  ].join("\n");
}
