/**
 * Pure in-memory token-bucket rate limiter.
 *
 * Used to bound the PUBLIC share-comment path (POST /api/s/[token]/comments),
 * keyed by shareId: a misbehaving (or hostile) link visitor can't flood the
 * comments table. Each key gets `capacity` tokens that refill linearly at
 * `capacity / windowMs` per ms; a request spends one token. When the bucket is
 * empty the request is rejected.
 *
 * LIMITATION (documented, by design for v1): state lives in a module-level Map
 * in this process only. With a single app container (the current Coolify
 * deployment) that's correct. If Desk ever runs multiple replicas, each replica
 * keeps its own bucket, so the effective global limit becomes N × the per-replica
 * limit — at which point this must move to a shared store (Redis/Postgres). The
 * Map also grows one entry per distinct key for the process lifetime; for the
 * share-id keyspace (bounded by the number of live shares) that is fine.
 */

export type RateLimitResult = {
  ok: boolean;
  /** Tokens remaining after this call (0 when rejected and empty). */
  remaining: number;
};

export type TokenBucketOptions = {
  /** Max tokens (= burst size and the per-window budget). */
  capacity: number;
  /** Refill window in ms over which `capacity` tokens are restored. */
  windowMs: number;
};

type Bucket = { tokens: number; updatedAt: number };

/**
 * A standalone token-bucket limiter instance. The module exports a shared
 * default (`shareCommentLimiter`) for the public comment path, but the class is
 * exported so tests can construct isolated instances with an injectable clock.
 */
export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.windowMs = opts.windowMs;
  }

  /**
   * Attempt to consume one token for `key`. `now` is injectable for
   * deterministic tests (defaults to Date.now()).
   */
  take(key: string, now: number = Date.now()): RateLimitResult {
    const refillPerMs = this.capacity / this.windowMs;
    const existing = this.buckets.get(key);

    let tokens: number;
    if (existing === undefined) {
      tokens = this.capacity;
    } else {
      const elapsed = Math.max(0, now - existing.updatedAt);
      tokens = Math.min(this.capacity, existing.tokens + elapsed * refillPerMs);
    }

    if (tokens >= 1) {
      tokens -= 1;
      this.buckets.set(key, { tokens, updatedAt: now });
      return { ok: true, remaining: Math.floor(tokens) };
    }

    // Rejected: still stamp the refill so the window advances correctly.
    this.buckets.set(key, { tokens, updatedAt: now });
    return { ok: false, remaining: 0 };
  }

  /** Test/maintenance helper — drop all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Shared limiter for the public share-comment path: 10 requests / minute per
 * shareId. Module-level singleton (see LIMITATION above).
 */
export const shareCommentLimiter = new TokenBucketRateLimiter({
  capacity: 10,
  windowMs: 60_000,
});

/**
 * Shared limiter for the public share "suggest an edit" path
 * (POST /api/s/[token]/suggest[/…]): 5 requests / hour per shareId. A
 * suggestion is a full doc body queued for owner review, so it is rate-limited
 * far more tightly than a comment — this is the only abuse control on the
 * unauthenticated (token-holding) write ingress. Module-level singleton (see
 * LIMITATION above).
 */
export const shareSuggestLimiter = new TokenBucketRateLimiter({
  capacity: 5,
  windowMs: 60 * 60_000,
});
