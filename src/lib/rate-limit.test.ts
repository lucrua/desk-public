import { describe, it, expect } from "vitest";
import { TokenBucketRateLimiter } from "./rate-limit";

describe("TokenBucketRateLimiter", () => {
  it("allows up to `capacity` calls then rejects", () => {
    const rl = new TokenBucketRateLimiter({ capacity: 10, windowMs: 60_000 });
    const t = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(rl.take("k", t).ok).toBe(true);
    }
    const denied = rl.take("k", t);
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("remaining decrements from capacity-1 down to 0", () => {
    const rl = new TokenBucketRateLimiter({ capacity: 3, windowMs: 60_000 });
    const t = 0;
    expect(rl.take("k", t).remaining).toBe(2);
    expect(rl.take("k", t).remaining).toBe(1);
    expect(rl.take("k", t).remaining).toBe(0);
    expect(rl.take("k", t).ok).toBe(false);
  });

  it("isolates buckets per key", () => {
    const rl = new TokenBucketRateLimiter({ capacity: 1, windowMs: 60_000 });
    const t = 0;
    expect(rl.take("a", t).ok).toBe(true);
    expect(rl.take("a", t).ok).toBe(false);
    // Different key has its own fresh bucket.
    expect(rl.take("b", t).ok).toBe(true);
  });

  it("refills linearly over the window", () => {
    const rl = new TokenBucketRateLimiter({ capacity: 10, windowMs: 60_000 });
    // Exhaust at t=0.
    for (let i = 0; i < 10; i++) rl.take("k", 0);
    expect(rl.take("k", 0).ok).toBe(false);

    // After 6s (1/10 of the window) one token is back.
    expect(rl.take("k", 6_000).ok).toBe(true);
    expect(rl.take("k", 6_000).ok).toBe(false);

    // After a full window, fully refilled (capped at capacity).
    expect(rl.take("k", 60_000).ok).toBe(true);
  });

  it("never exceeds capacity even after a long idle period", () => {
    const rl = new TokenBucketRateLimiter({ capacity: 5, windowMs: 1_000 });
    rl.take("k", 0); // remaining 4
    // Idle for 1000 windows — should still cap at 5, i.e. 5 successes then deny.
    let ok = 0;
    for (let i = 0; i < 20; i++) {
      if (rl.take("k", 1_000_000).ok) ok++;
    }
    expect(ok).toBe(5);
  });

  it("reset() clears all buckets", () => {
    const rl = new TokenBucketRateLimiter({ capacity: 1, windowMs: 60_000 });
    expect(rl.take("k", 0).ok).toBe(true);
    expect(rl.take("k", 0).ok).toBe(false);
    rl.reset();
    expect(rl.take("k", 0).ok).toBe(true);
  });
});
