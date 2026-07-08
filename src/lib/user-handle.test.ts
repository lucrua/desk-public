import { describe, it, expect, beforeEach } from "vitest";
import { asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { resetDb } from "@/test/db";
import { createUser, listUsers } from "@/lib/users";
import {
  slugifyHandle,
  deriveHandleBase,
  dedupeHandle,
  backfillUserHandles,
  MAX_HANDLE_LEN,
  HANDLE_RE,
} from "@/lib/user-handle";

/** Insert a user row directly (bypassing createUser) so handle stays NULL —
 *  the pre-backfill state. Returns the new id. */
async function rawUser(input: {
  email?: string | null;
  tokenName?: string | null;
  displayName?: string;
}): Promise<number> {
  const [row] = await db
    .insert(schema.users)
    .values({
      email: input.email ?? null,
      tokenName: input.tokenName ?? null,
      displayName: input.displayName ?? "X",
    })
    .returning({ id: schema.users.id });
  return row.id;
}

/** All (id, handle) pairs, id ascending. */
async function handlesById(): Promise<Array<{ id: number; handle: string | null }>> {
  return db
    .select({ id: schema.users.id, handle: schema.users.handle })
    .from(schema.users)
    .orderBy(asc(schema.users.id));
}

describe("user-handle — pure derivation helpers", () => {
  it("slugifyHandle lowercases, replaces non-alnum runs, trims dashes", () => {
    expect(slugifyHandle("Lucas.Smith")).toBe("lucas-smith");
    expect(slugifyHandle("  Weird__Name!! ")).toBe("weird-name");
    expect(slugifyHandle("--lead-and-trail--")).toBe("lead-and-trail");
    expect(slugifyHandle("@@@")).toBe(""); // nothing survives
  });

  it("slugifyHandle caps at MAX_HANDLE_LEN and re-trims a trailing dash", () => {
    const out = slugifyHandle("a".repeat(50));
    expect(out.length).toBe(MAX_HANDLE_LEN);
    // A truncation that lands on a '-' is trimmed.
    const trimmed = slugifyHandle("ab-".repeat(20)); // ...-ab-ab-ab...
    expect(trimmed.endsWith("-")).toBe(false);
  });

  it("deriveHandleBase prefers tokenName, then email-local, then u<id>", () => {
    expect(deriveHandleBase({ tokenName: "CI Publisher", email: "x@y.com" }, 7)).toBe("ci-publisher");
    expect(deriveHandleBase({ tokenName: null, email: "lucas@example.org" }, 7)).toBe("lucas");
    expect(deriveHandleBase({ tokenName: null, email: null }, 42)).toBe("u42");
    // identifier that slugifies to nothing → u<id> fallback
    expect(deriveHandleBase({ tokenName: "@@@", email: null }, 9)).toBe("u9");
  });

  it("dedupeHandle appends -2/-3… and respects the length cap", () => {
    expect(dedupeHandle("lucas", new Set())).toBe("lucas");
    expect(dedupeHandle("lucas", new Set(["lucas"]))).toBe("lucas-2");
    expect(dedupeHandle("lucas", new Set(["lucas", "lucas-2"]))).toBe("lucas-3");
    // long base: the suffix must fit within MAX_HANDLE_LEN.
    const long = "a".repeat(MAX_HANDLE_LEN);
    const out = dedupeHandle(long, new Set([long]));
    expect(out.length).toBeLessThanOrEqual(MAX_HANDLE_LEN);
    expect(out.endsWith("-2")).toBe(true);
  });
});

describe("backfillUserHandles — determinism, de-dup, idempotency", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("three users all deriving 'lucas' → lucas, lucas-2, lucas-3 (id ascending)", async () => {
    const a = await rawUser({ email: "lucas@a.com" });
    const b = await rawUser({ email: "lucas@b.com" });
    const c = await rawUser({ email: "lucas@c.com" });

    const r = await backfillUserHandles();
    expect(r.assigned).toBe(3);

    const rows = await handlesById();
    const byId = new Map(rows.map((x) => [x.id, x.handle]));
    expect(byId.get(a)).toBe("lucas");
    expect(byId.get(b)).toBe("lucas-2");
    expect(byId.get(c)).toBe("lucas-3");
    // all assigned handles match the format
    for (const row of rows) expect(HANDLE_RE.test(row.handle!)).toBe(true);
  });

  it("agent (tokenName) and no-identifier fallback (u<id>)", async () => {
    const agent = await rawUser({ tokenName: "CI Publisher", displayName: "CI" });
    const ghost = await rawUser({ email: null, tokenName: null, displayName: "Ghost" });

    await backfillUserHandles();

    const rows = await handlesById();
    const byId = new Map(rows.map((x) => [x.id, x.handle]));
    expect(byId.get(agent)).toBe("ci-publisher");
    expect(byId.get(ghost)).toBe(`u${ghost}`);
  });

  it("idempotent: a re-run assigns nothing and leaves handles untouched", async () => {
    await rawUser({ email: "lucas@a.com" });
    await rawUser({ email: "lucas@b.com" });

    const first = await backfillUserHandles();
    expect(first.assigned).toBe(2);
    const snapshot = await handlesById();

    const second = await backfillUserHandles();
    expect(second.assigned).toBe(0);
    expect(await handlesById()).toEqual(snapshot);
  });

  it("de-dups against a handle already assigned to another row", async () => {
    // A user that already carries handle 'lucas' (e.g. assigned on creation).
    await db
      .insert(schema.users)
      .values({ email: "lucas@existing.com", displayName: "Existing", handle: "lucas" });
    const late = await rawUser({ email: "lucas@late.com" });

    const r = await backfillUserHandles();
    expect(r.assigned).toBe(1); // only the null-handle row

    const rows = await handlesById();
    const byId = new Map(rows.map((x) => [x.id, x.handle]));
    expect(byId.get(late)).toBe("lucas-2"); // avoids the existing 'lucas'
  });
});

describe("createUser assigns a unique handle at creation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("first lucas → 'lucas'; second distinct lucas → 'lucas-2'", async () => {
    const a = await createUser({ email: "lucas@a.com", displayName: "Lucas A", role: "member" });
    const b = await createUser({ email: "lucas@b.com", displayName: "Lucas B", role: "member" });
    expect(a!.handle).toBe("lucas");
    expect(b!.handle).toBe("lucas-2");
    // and the stored rows agree
    const users = await listUsers();
    expect(users.find((u) => u.id === a!.id)!.handle).toBe("lucas");
    expect(users.find((u) => u.id === b!.id)!.handle).toBe("lucas-2");
  });

  it("agent (tokenName-only) creation gets a slugified handle", async () => {
    const agent = await createUser({ tokenName: "CI Publisher", displayName: "CI", role: "member" });
    expect(agent!.handle).toBe("ci-publisher");
    expect(HANDLE_RE.test(agent!.handle!)).toBe(true);
  });
});
