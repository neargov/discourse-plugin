import { randomBytes } from "crypto";

export class NonceCapacityError extends Error {
  readonly limitType: "client" | "global";
  readonly limit: number;
  readonly clientId?: string;

  constructor(params: { limitType: "client" | "global"; limit: number; clientId?: string }) {
    const scope = params.limitType === "client" ? `client ${params.clientId ?? "unknown"}` : "global";
    super(`Nonce capacity exceeded (${scope} limit: ${params.limit})`);
    this.name = "NonceCapacityError";
    this.limitType = params.limitType;
    this.limit = params.limit;
    this.clientId = params.clientId;
  }
}

export type NonceManagerOptions = {
  ttlMs?: number;
  maxPerClient?: number;
  maxTotal?: number;
  limitStrategy?: {
    perClient?: "rejectNew" | "evictOldest";
    global?: "rejectNew" | "evictOldest";
  };
  onEvict?: (event: { type: "client" | "global"; clientId?: string; count: number }) => void;
};

const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT_STRATEGY = {
  perClient: "rejectNew" as const,
  global: "rejectNew" as const,
};

/**
 * NonceManager - Manages temporary nonces with private keys
 */
export class NonceManager {
  private nonces = new Map<
    string,
    { clientId: string; privateKey: string; timestamp: number }
  >();
  private readonly ttl: number;
  private readonly maxPerClient?: number;
  private readonly maxTotal?: number;
  private readonly perClientStrategy: "rejectNew" | "evictOldest";
  private readonly globalStrategy: "rejectNew" | "evictOldest";
  private readonly onEvict?: (event: {
    type: "client" | "global";
    clientId?: string;
    count: number;
  }) => void;
  private isExpired = (timestamp: number) => Date.now() - timestamp > this.ttl;
  private normalizeClientIdOrNull(value?: string): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return normalized.length ? normalized : null;
  }

  private normalizeClientId(value: string): string {
    const normalized = this.normalizeClientIdOrNull(value);
    if (!normalized) {
      throw new Error("clientId is required");
    }
    return normalized;
  }

  private normalizePrivateKey(value: string): string {
    if (typeof value !== "string") {
      throw new Error("privateKey is required");
    }
    const normalized = value.trim();
    if (!normalized) {
      throw new Error("privateKey is required");
    }
    return normalized;
  }

  constructor(ttlMs?: number);
  constructor(options: NonceManagerOptions);
  constructor(ttlMsOrOptions: number | NonceManagerOptions = DEFAULT_NONCE_TTL_MS) {
    const {
      ttlMs = DEFAULT_NONCE_TTL_MS,
      maxPerClient,
      maxTotal,
      limitStrategy,
      onEvict,
    } = typeof ttlMsOrOptions === "object" ? ttlMsOrOptions : { ttlMs: ttlMsOrOptions };

    this.ttl = this.normalizeTtl(ttlMs);
    this.maxPerClient = this.normalizeLimit(maxPerClient);
    this.maxTotal = this.normalizeLimit(maxTotal);
    this.perClientStrategy = limitStrategy?.perClient ?? DEFAULT_LIMIT_STRATEGY.perClient;
    this.globalStrategy = limitStrategy?.global ?? DEFAULT_LIMIT_STRATEGY.global;
    this.onEvict = typeof onEvict === "function" ? onEvict : undefined;
  }

  create(clientId: string, privateKey: string): string {
    this.cleanup();
    const normalizedClientId = this.normalizeClientId(clientId);
    const normalizedPrivateKey = this.normalizePrivateKey(privateKey);
    this.ensureCapacity(normalizedClientId);
    const nonce = randomBytes(32).toString("hex");
    this.nonces.set(nonce, {
      clientId: normalizedClientId,
      privateKey: normalizedPrivateKey,
      timestamp: Date.now(),
    });
    return nonce;
  }

  get(
    nonce: string
  ): { clientId: string; privateKey: string; timestamp: number } | null {
    const data = this.nonces.get(nonce);
    if (!data) return null;
    if (this.isExpired(data.timestamp)) {
      this.nonces.delete(nonce);
      return null;
    }
    return data;
  }

  verify(nonce: string, clientId: string): boolean {
    const data = this.nonces.get(nonce);
    if (!data) return false;
    if (this.isExpired(data.timestamp)) {
      this.nonces.delete(nonce);
      return false;
    }
    const normalizedClientId = this.normalizeClientIdOrNull(clientId);
    if (!normalizedClientId) {
      return false;
    }
    return data.clientId === normalizedClientId;
  }

  getPrivateKey(nonce: string): string | null {
    return this.get(nonce)?.privateKey || null;
  }

  getExpiration(nonce: string): number | null {
    const data = this.get(nonce);
    if (!data) return null;
    return data.timestamp + this.ttl;
  }

  getNextExpiration(clientId?: string): number | null {
    this.cleanup();
    const normalizedClientId = this.normalizeClientIdOrNull(clientId);
    let next: number | null = null;
    for (const [nonce, data] of this.nonces.entries()) {
      if (this.isExpired(data.timestamp)) {
        this.nonces.delete(nonce);
        continue;
      }
      if (normalizedClientId && data.clientId !== normalizedClientId) {
        continue;
      }
      const expiration = data.timestamp + this.ttl;
      if (next === null || expiration < next) {
        next = expiration;
      }
    }
    return next;
  }

  getRetryAfterMs(clientId?: string): number | null {
    const nextExpiration = this.getNextExpiration(
      clientId ? this.normalizeClientIdOrNull(clientId) ?? undefined : undefined
    );
    if (nextExpiration === null) {
      return null;
    }
    return Math.max(0, nextExpiration - Date.now());
  }

  consume(nonce: string): void {
    this.nonces.delete(nonce);
  }

  cleanup(): void {
    for (const [nonce, data] of this.nonces.entries()) {
      if (this.isExpired(data.timestamp)) {
        this.nonces.delete(nonce);
      }
    }
  }

  private normalizeTtl(ttlMs: number): number {
    return typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0
      ? ttlMs
      : DEFAULT_NONCE_TTL_MS;
  }

  private normalizeLimit(limit?: number): number | undefined {
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
  }

  private notifyEvict(event: { type: "client" | "global"; clientId?: string; count: number }) {
    if (event.count > 0) {
      this.onEvict?.(event);
    }
  }

  private countByClient(clientId: string): number {
    let count = 0;
    for (const entry of this.nonces.values()) {
      if (entry.clientId === clientId) {
        count += 1;
      }
    }
    return count;
  }

  private evictOldest(predicate: (entry: { clientId: string; timestamp: number }) => boolean): boolean {
    let oldestNonce: string | null = null;
    let oldestTimestamp: number | null = null;

    for (const [nonce, data] of this.nonces.entries()) {
      if (!predicate(data)) {
        continue;
      }
      if (oldestTimestamp === null || data.timestamp < oldestTimestamp) {
        oldestNonce = nonce;
        oldestTimestamp = data.timestamp;
      }
    }

    if (oldestNonce) {
      this.nonces.delete(oldestNonce);
      return true;
    }

    return false;
  }

  private evictForClient(clientId: string, maxCount: number): boolean {
    if (maxCount < 0) return false;

    let evicted = 0;
    while (this.countByClient(clientId) > maxCount) {
      if (!this.evictOldest((entry) => entry.clientId === clientId)) {
        break;
      }
      evicted += 1;
    }
    this.notifyEvict({ type: "client", clientId, count: evicted });
    return evicted > 0;
  }

  private evictGlobally(maxCount: number): boolean {
    if (maxCount < 0) return false;

    let evicted = 0;
    while (this.nonces.size > maxCount) {
      if (!this.evictOldest(() => true)) {
        break;
      }
      evicted += 1;
    }

    this.notifyEvict({ type: "global", count: evicted });

    return evicted > 0;
  }

  private ensureCapacity(clientId: string): void {
    if (this.maxPerClient !== undefined) {
      if (this.countByClient(clientId) >= this.maxPerClient) {
        const evicted = this.evictForClient(clientId, this.maxPerClient - 1);
        if (this.perClientStrategy === "evictOldest" && evicted) {
          // allow replacement after eviction
        } else {
          throw new NonceCapacityError({
            limitType: "client",
            limit: this.maxPerClient,
            clientId,
          });
        }
      }
    }

    if (this.maxTotal !== undefined) {
      if (this.nonces.size >= this.maxTotal) {
        const evicted = this.evictGlobally(this.maxTotal - 1);
        if (this.globalStrategy === "evictOldest" && evicted) {
          // allow replacement after eviction
        } else {
          throw new NonceCapacityError({
            limitType: "global",
            limit: this.maxTotal,
          });
        }
      }
    }
  }
}
