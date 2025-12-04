import type { SafeLogger } from "./service";
import { normalizeMeta } from "./utils";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export type Cache = {
  get: <T>(key: string) => T | undefined;
  set: <T>(key: string, value: T) => void;
  delete: (key: string) => void;
  deleteByPrefix?: (prefix: string) => number;
  stats: () => { size: number; hits: number; misses: number; evictions: number; ttlMs: number };
};

export const createCache = (
  maxSize: number,
  ttlMs: number,
  options?: { logger?: SafeLogger; now?: () => number }
): Cache => {
  const capacity = Number.isFinite(maxSize) && maxSize > 0 ? Math.floor(maxSize) : 0;
  const safeTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
  const map = new Map<string, CacheEntry<unknown>>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  const logger = options?.logger;
  const now = options?.now ?? (() => Date.now());

  const logDebug = (message: string, meta?: Record<string, unknown>) => {
    logger?.debug?.(message, normalizeMeta(meta));
  };

  if (capacity === 0 || safeTtlMs <= 0) {
    logDebug("Cache disabled", { action: "cache-init", maxSize, ttlMs: safeTtlMs });
  }

  const purgeExpired = () => {
    if (safeTtlMs <= 0) return;
    const nowMs = now();
    for (const [key, entry] of map.entries()) {
      if (entry.expiresAt < nowMs) {
        map.delete(key);
        evictions += 1;
        logDebug("Cache eviction", {
          action: "cache-evict",
          reason: "expired",
          key,
          ttlMs: safeTtlMs,
        });
      }
    }
  };

  const get = <T>(key: string): T | undefined => {
    purgeExpired();
    const entry = map.get(key);
    if (!entry) {
      misses += 1;
      return undefined;
    }
    const nowMs = now();
    if (entry.expiresAt < nowMs) {
      map.delete(key);
      evictions += 1;
      logDebug("Cache eviction", {
        action: "cache-evict",
        reason: "expired",
        key,
        ttlMs: safeTtlMs,
      });
      misses += 1;
      return undefined;
    }
    hits += 1;
    map.delete(key);
    map.set(key, entry);
    return entry.value as T;
  };

  const set = <T>(key: string, value: T) => {
    if (capacity === 0 || safeTtlMs <= 0) return;
    purgeExpired();
    if (map.has(key)) {
      map.delete(key);
    }
    while (map.size >= capacity) {
      const oldestKey = map.keys().next().value!;
      map.delete(oldestKey);
      evictions += 1;
      logDebug("Cache eviction", {
        action: "cache-evict",
        reason: "capacity",
        key: oldestKey,
        ttlMs: safeTtlMs,
      });
    }
    map.set(key, { value, expiresAt: now() + safeTtlMs });
  };

  /* c8 ignore start */
  const del = (key: string) => {
    if (map.delete(key)) {
      evictions += 1;
      logDebug("Cache eviction", { action: "cache-evict", reason: "manual", key });
    }
  };
  /* c8 ignore stop */

  const deleteByPrefix = (prefix: string) => {
    let removed = 0;
    for (const key of map.keys()) {
      if (key.startsWith(prefix)) {
        map.delete(key);
        removed += 1;
        evictions += 1;
        logDebug("Cache eviction", {
          action: "cache-evict",
          reason: "prefix",
          key,
          prefix,
        });
      }
    }
    return removed;
  };

  const stats = () => ({
    ...(purgeExpired(), {}),
    size: map.size,
    hits,
    misses,
    evictions,
    ttlMs: safeTtlMs,
  });

  return { get, set, delete: del, deleteByPrefix, stats };
};
