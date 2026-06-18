"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Top-bar navigation with active-route highlighting. Client island because
 * App Router layouts don't receive the pathname on the server — usePathname()
 * is the supported way to know where the user is.
 *
 * A link is active when the pathname equals its href or sits beneath it
 * (`/docs/notes-overview` keeps Docs lit).
 *
 * `approvalCount` — open revision proposals visible to this principal (0 hides badge).
 */
export default function HubNav({
  isAdmin,
  approvalCount = 0,
}: {
  isAdmin: boolean;
  approvalCount?: number;
}) {
  const pathname = usePathname() ?? "";

  const links: { href: string; label: string; disabled?: boolean; badge?: number }[] = [
    { href: "/docs", label: "Docs" },
    { href: "/board", label: "Board" },
    { href: "/catalog", label: "Catalog" },
    { href: "/approvals", label: "Approvals", badge: approvalCount > 0 ? approvalCount : undefined },
    { href: "/help", label: "Help" },
    ...(isAdmin ? [{ href: "/admin", label: "Admin" }] : []),
    ...(isAdmin ? [{ href: "/distribution", label: "Distribution" }] : []),
  ];

  const base = {
    fontSize: 13,
    padding: "5px 10px",
    borderRadius: 6,
    textDecoration: "none",
  } as const;

  return (
    <nav style={{ display: "flex", gap: 2, flex: 1 }}>
      {links.map((l) => {
        if (l.disabled) {
          return (
            <span
              key={l.label}
              aria-disabled="true"
              title="Coming soon"
              style={{ ...base, color: "var(--faint)", cursor: "default", opacity: 0.6 }}
            >
              {l.label}
            </span>
          );
        }
        const active = pathname === l.href || pathname.startsWith(l.href + "/");
        return (
          <Link
            key={l.label}
            href={l.href}
            aria-current={active ? "page" : undefined}
            style={{
              ...(active
                ? { ...base, color: "var(--ink)", background: "var(--nav-active)", fontWeight: 500 }
                : { ...base, color: "var(--muted)" }),
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {l.label}
            {l.badge != null && (
              <span
                aria-label={`${l.badge} open`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: 16,
                  height: 16,
                  padding: "0 4px",
                  borderRadius: 999,
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: 10,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontWeight: 600,
                  lineHeight: 1,
                }}
              >
                {l.badge}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
