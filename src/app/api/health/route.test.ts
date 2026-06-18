import { describe, it, expect } from "vitest";
import { GET } from "./route";
import pkg from "../../../../package.json";

describe("GET /api/health", () => {
  it("returns 200 with {ok:true, version} for an anonymous (no-auth) request", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.version).toBe(pkg.version);
  });

  it("does not require any header — bare GET works", async () => {
    // No Request object passed at all (the handler takes no args). This proves
    // the probe touches nothing but the process — safe for Coolify healthchecks.
    const res = await GET();
    expect(res.status).toBe(200);
  });
});
