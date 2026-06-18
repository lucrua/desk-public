/**
 * A staff principal. `email` is the row's PRIMARY/display email (users.email);
 * `emails` carries ALL of the user's verified addresses (the user_emails set,
 * including the primary), normalized (trim + lowercase). Identity matches
 * (self-deactivation guard, card ownership) test against `emails` so a login via
 * a secondary address still resolves as "me". `emails` is absent on a pure
 * service-token principal (no email).
 *
 * `userId` is the resolved users.id row for this principal — required for
 * doc-ownership checks (canPublishVersion, canDecideRevision). Populated on all
 * staff principals; absent on anonymous.
 */
type StaffPrincipal = {
  name: string;
  email?: string;
  emails?: string[];
  tokenName?: string;
  /**
   * The resolved users.id for this principal (ownership checks). Populated on
   * CF-auth principals (cloudflare.ts) and the bootstrap path; undefined on the
   * dev-mode stub (no DB lookup). Always check `!= null` before comparing.
   */
  userId?: number;
};

export type Principal =
  | ({ kind: "admin" } & StaffPrincipal)
  | ({ kind: "member" } & StaffPrincipal)
  | { kind: "anonymous" };

export const isStaff = (p: Principal): p is Extract<Principal, { kind: "admin" | "member" }> =>
  p.kind === "admin" || p.kind === "member";
