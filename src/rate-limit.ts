type RateLimitStrategy = "global" | "perAction" | "perClient" | "perActionClient";

export type RateLimiter = {
  take: (action: string, clientId?: string) => { allowed: boolean; retryAfterMs: number };
};

const DEFAULT_RATE_LIMIT_BUCKET_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX_BUCKETS = 1000;

export const createRateLimiter = (params: {
  requestsPerSecond: number;
  strategy?: RateLimitStrategy;
  maxBuckets?: number;
  bucketTtlMs?: number;
}): RateLimiter => {
  const rate =
    Number.isFinite(params.requestsPerSecond) && params.requestsPerSecond > 0
      ? params.requestsPerSecond
      : 1;
  const capacity = Math.max(1, rate);
  const strategy = params.strategy ?? "global";
  const maxBucketsInput = params.maxBuckets ?? DEFAULT_RATE_LIMIT_MAX_BUCKETS;
  const maxBuckets =
    Number.isFinite(maxBucketsInput) && maxBucketsInput > 0 ? Math.floor(maxBucketsInput) : null;
  const bucketTtlMsInput = params.bucketTtlMs ?? DEFAULT_RATE_LIMIT_BUCKET_TTL_MS;
  const bucketTtlMs =
    Number.isFinite(bucketTtlMsInput) && bucketTtlMsInput > 0
      ? bucketTtlMsInput
      : DEFAULT_RATE_LIMIT_BUCKET_TTL_MS;
  const buckets = new Map<
    string,
    {
      tokens: number;
      lastRefill: number;
    }
  >();

  const resolveKey = (action: string, clientId?: string) => {
    const safeAction = action || "default";
    const safeClient = clientId?.trim() || "default";
    if (strategy === "perAction") return `action:${safeAction}`;
    if (strategy === "perClient") return `client:${safeClient}`;
    if (strategy === "perActionClient") return `action-client:${safeAction}:${safeClient}`;
    return "global";
  };

  const purgeIdleBuckets = (now: number) => {
    if (bucketTtlMs) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.lastRefill > bucketTtlMs) {
          buckets.delete(key);
        }
      }
    }
  };

  const getBucket = (key: string) => {
    const now = Date.now();
    purgeIdleBuckets(now);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (maxBuckets) {
        while (buckets.size >= maxBuckets) {
          const oldestKey = buckets.keys().next().value!;
          buckets.delete(oldestKey);
        }
      }
      bucket = { tokens: capacity, lastRefill: Date.now() };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const takeFromBucket = (bucket: { tokens: number; lastRefill: number }) => {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 1000) * rate;
      bucket.tokens = Math.min(capacity, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true as const, retryAfterMs: 0 };
    }

    const missingTokens = 1 - Math.max(0, bucket.tokens);
    const retryAfterMs = Math.max(0, Math.ceil((missingTokens / rate) * 1000));
    return { allowed: false as const, retryAfterMs };
  };

  return {
    take: (action: string, clientId?: string) => {
      purgeIdleBuckets(Date.now());
      const key = resolveKey(action, clientId);
      const bucket = getBucket(key);
      return takeFromBucket(bucket);
    },
  };
};
