"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

type Role = "admin" | "member" | "anonymous";

const ROLES: Role[] = ["admin", "member", "anonymous"];

// Write the dev-role cookie. Anonymous clears it (no role → pending screen).
// Module-scoped so the cookie write isn't flagged by react-hooks/immutability
// (the rule treats `document.cookie = …` inside a component as state mutation).
function writeRoleCookie(role: Role): void {
  const cookie =
    role === "anonymous"
      ? "hub-dev-role=; path=/; max-age=0; SameSite=Lax"
      : `hub-dev-role=${role}; path=/; max-age=31536000; SameSite=Lax`;
  globalThis.document.cookie = cookie;
}

/**
 * Floating dev-only role switcher (design handoff: bottom-center pill).
 *
 * Writes the `hub-dev-role` cookie that the dev auth provider reads, then
 * router.refresh() so the server layout re-resolves the principal. Selecting
 * "anonymous" clears the cookie (no valid role → the layout shows the pending
 * screen). Rendered only when AUTH_MODE !== "cloudflare" (gated by the layout).
 *
 * `current` is resolved server-side from the principal and passed in, so the
 * active pill is correct on first paint.
 */
export default function DevSwitcher({ current }: { current: Role }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function pick(role: Role) {
    writeRoleCookie(role);
    startTransition(() => router.refresh());
  }

  return (
    <div
      role="group"
      aria-label="Dev role switcher"
      style={{
        position: "fixed",
        bottom: 18,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        alignItems: "center",
        gap: 4,
        background: "rgba(24, 21, 17, 0.92)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 999,
        padding: "5px 6px",
        boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
        backdropFilter: "blur(8px)",
        zIndex: 50,
        fontFamily: "var(--font-mono)",
        opacity: pending ? 0.7 : 1,
      }}
    >
      <span
        style={{
          fontSize: 9.5,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.45)",
          padding: "0 8px 0 10px",
        }}
      >
        role
      </span>
      {ROLES.map((r) => {
        const active = r === current;
        return (
          <button
            key={r}
            type="button"
            onClick={() => pick(r)}
            aria-pressed={active}
            disabled={pending}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              padding: "6px 11px",
              borderRadius: 999,
              border: "none",
              cursor: pending ? "default" : "pointer",
              background: active ? "rgba(255,255,255,0.92)" : "transparent",
              color: active ? "#1A1713" : "rgba(255,255,255,0.75)",
            }}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}
