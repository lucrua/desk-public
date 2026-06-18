import { describe, it, expect } from "vitest";
import { decideRoute, type RouteDecision } from "./host-routing";

// ── table-driven suite ────────────────────────────────────────────────────────

type Case = {
  desc: string;
  host: string | null;
  pathname: string;
  shareHost: string | undefined;
  want: RouteDecision;
};

const cases: Case[] = [
  // ── shareHost unset → always pass (local dev) ─────────────────────────────
  {
    desc: "shareHost unset + /docs → pass",
    host: "localhost:3000",
    pathname: "/docs",
    shareHost: undefined,
    want: "pass",
  },
  {
    desc: "shareHost unset + /admin → pass",
    host: "localhost:3000",
    pathname: "/admin",
    shareHost: undefined,
    want: "pass",
  },
  {
    desc: "shareHost unset + / → pass",
    host: "hub.example.com",
    pathname: "/",
    shareHost: undefined,
    want: "pass",
  },
  {
    desc: "shareHost unset + /s/abc → pass",
    host: "share.example.com",
    pathname: "/s/abc",
    shareHost: undefined,
    want: "pass",
  },
  {
    desc: "shareHost empty string → treated as unset → pass",
    host: "share.example.com",
    pathname: "/admin",
    shareHost: "",
    want: "pass",
  },

  // ── hub hostname with shareHost set → pass everything ─────────────────────
  {
    desc: "hub host + /docs → pass",
    host: "hub.example.com",
    pathname: "/docs",
    shareHost: "share.example.com",
    want: "pass",
  },
  {
    desc: "hub host + /admin → pass",
    host: "hub.example.com",
    pathname: "/admin",
    shareHost: "share.example.com",
    want: "pass",
  },
  {
    desc: "hub host + /api/docs → pass",
    host: "hub.example.com",
    pathname: "/api/docs",
    shareHost: "share.example.com",
    want: "pass",
  },
  {
    desc: "hub host + / → pass",
    host: "hub.example.com",
    pathname: "/",
    shareHost: "share.example.com",
    want: "pass",
  },

  // ── share host: allowed paths ──────────────────────────────────────────────
  {
    desc: "share host + /s/abc → pass",
    host: "share.example.com",
    pathname: "/s/abc",
    shareHost: "share.example.com",
    want: "pass",
  },
  {
    desc: "share host + /s/ (bare prefix) → pass",
    host: "share.example.com",
    pathname: "/s/",
    shareHost: "share.example.com",
    want: "pass",
  },
  {
    desc: "share host + /s/very/deep/path → pass",
    host: "share.example.com",
    pathname: "/s/tok-abc123/some-extra",
    shareHost: "share.example.com",
    want: "pass",
  },
  {
    desc: "share host + /robots.txt → pass",
    host: "share.example.com",
    pathname: "/robots.txt",
    shareHost: "share.example.com",
    want: "pass",
  },
  {
    desc: "share host + /_next/static/... → pass",
    host: "share.example.com",
    pathname: "/_next/static/chunks/main.js",
    shareHost: "share.example.com",
    want: "pass",
  },
  {
    desc: "share host + /_next/image → pass",
    host: "share.example.com",
    pathname: "/_next/image?url=...",
    shareHost: "share.example.com",
    want: "pass",
  },

  // ── share host: blocked paths → not-found ─────────────────────────────────
  {
    desc: "share host + / → not-found",
    host: "share.example.com",
    pathname: "/",
    shareHost: "share.example.com",
    want: "not-found",
  },
  {
    desc: "share host + /docs → not-found",
    host: "share.example.com",
    pathname: "/docs",
    shareHost: "share.example.com",
    want: "not-found",
  },
  {
    desc: "share host + /docs/some-slug → not-found",
    host: "share.example.com",
    pathname: "/docs/some-slug",
    shareHost: "share.example.com",
    want: "not-found",
  },
  {
    desc: "share host + /admin → not-found",
    host: "share.example.com",
    pathname: "/admin",
    shareHost: "share.example.com",
    want: "not-found",
  },
  {
    desc: "share host + /api/docs → not-found",
    host: "share.example.com",
    pathname: "/api/docs",
    shareHost: "share.example.com",
    want: "not-found",
  },
  {
    desc: "share host + /api/shares → not-found",
    host: "share.example.com",
    pathname: "/api/shares",
    shareHost: "share.example.com",
    want: "not-found",
  },
  {
    desc: "share host + /mcp → not-found",
    host: "share.example.com",
    pathname: "/mcp",
    shareHost: "share.example.com",
    want: "not-found",
  },

  // ── host with port ─────────────────────────────────────────────────────────
  {
    desc: "share host with port stripped → not-found for /admin",
    host: "share.example.com:443",
    pathname: "/admin",
    shareHost: "share.example.com",
    want: "not-found",
  },
  {
    desc: "share host with port stripped → pass for /s/abc",
    host: "share.example.com:443",
    pathname: "/s/abc",
    shareHost: "share.example.com",
    want: "pass",
  },

  // ── case-insensitivity ─────────────────────────────────────────────────────
  {
    desc: "host uppercase → normalised to lower → not-found",
    host: "SHARE.EXAMPLE.COM",
    pathname: "/admin",
    shareHost: "share.example.com",
    want: "not-found",
  },
  {
    desc: "shareHost uppercase → normalised to lower → not-found",
    host: "share.example.com",
    pathname: "/admin",
    shareHost: "SHARE.EXAMPLE.COM",
    want: "not-found",
  },
  {
    desc: "both uppercase → normalised → pass for /s/abc",
    host: "SHARE.EXAMPLE.COM",
    pathname: "/s/abc",
    shareHost: "SHARE.EXAMPLE.COM",
    want: "pass",
  },

  // ── null host (edge cases) ─────────────────────────────────────────────────
  {
    desc: "null host with shareHost set → treated as non-match → pass",
    host: null,
    pathname: "/admin",
    shareHost: "share.example.com",
    want: "pass",
  },
  {
    desc: "null host with shareHost unset → pass",
    host: null,
    pathname: "/admin",
    shareHost: undefined,
    want: "pass",
  },
];

describe("decideRoute", () => {
  for (const c of cases) {
    it(c.desc, () => {
      expect(decideRoute(c.host, c.pathname, c.shareHost)).toBe(c.want);
    });
  }
});
