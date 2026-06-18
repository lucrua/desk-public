import type { Principal } from "./principal";

const VALID_ROLES = ["admin", "member"] as const;
type StaffRole = (typeof VALID_ROLES)[number];

function isValidRole(v: string | null | undefined): v is StaffRole {
  return VALID_ROLES.includes(v as StaffRole);
}

/** Parse the `cookie` header string for a named cookie value. */
function parseCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k.trim() === name) return rest.join("=").trim();
  }
  return undefined;
}

/**
 * Resolve a principal from the dev role-switcher header/cookie.
 *
 * Priority: `x-dev-role` header > `hub-dev-role` cookie.
 * Only the values `admin` and `member` produce staff principals;
 * anything else (including absent) → anonymous.
 *
 * @throws if NODE_ENV === "production" — the dev provider must never
 *         be reachable in production.
 */
export async function principalFromDevHeaders(headers: Headers): Promise<Principal> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Dev identity provider must not be used in production");
  }

  // Header takes priority over cookie.
  const headerRole = headers.get("x-dev-role");
  if (headerRole !== null) {
    if (isValidRole(headerRole)) {
      return {
        kind: headerRole,
        name: headerRole === "admin" ? "Dev Admin" : "Dev Member",
      };
    }
    return { kind: "anonymous" };
  }

  // Fall back to cookie.
  const cookieHeader = headers.get("cookie") ?? "";
  const cookieRole = parseCookie(cookieHeader, "hub-dev-role");
  if (cookieRole !== undefined) {
    if (isValidRole(cookieRole)) {
      return {
        kind: cookieRole,
        name: cookieRole === "admin" ? "Dev Admin" : "Dev Member",
      };
    }
    return { kind: "anonymous" };
  }

  return { kind: "anonymous" };
}
