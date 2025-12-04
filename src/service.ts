import { Effect } from "every-plugin/effect";
import { CryptoService } from "./crypto-service";
import {
  NonceCapacityError as NonceCapacityErrorImpl,
  NonceManager as NonceManagerImpl,
  type NonceManagerOptions,
} from "./nonce-manager";
export { CryptoService };
export {
  NonceCapacityErrorImpl as NonceCapacityError,
  NonceManagerImpl as NonceManager,
};
export type { NonceManagerOptions };
import type { RetryPolicy } from "./constants";
import type { PostActionResult } from "./contract";
export type { Upload, UploadRequest, PresignedUpload, MultipartPresign } from "./contract";
export type { DomainFactories } from "./services/domains";
import {
  createDomainServices,
  type DomainFactories,
} from "./services/domains";
import {
  createSafeLogger,
  noopLogger,
  type Logger,
  type RequestLogEvent,
  type RequestLogger,
  type SafeLogger,
} from "./logging";
import {
  DiscourseApiError,
  DiscourseClient,
  type OperationRetryPolicy,
} from "./client";
import {
  createDomainMethodAdapters,
  type DomainMethodAdapters,
} from "./services/adapters";
import {
  mapPost,
  mapRevision,
  resolvePostActionType,
} from "./resources/posts";
import { mapCategory } from "./resources/categories";
import { mapTopic } from "./resources/topics";

export { DiscourseApiError, createSafeLogger, noopLogger };
export type {
  Logger,
  SafeLogger,
  OperationRetryPolicy,
  RequestLogger,
  RequestLogEvent,
};

export type DiscourseServiceOptions = {
  defaultTimeoutMs?: number;
  userAgent?: string;
  userApiClientId?: string;
  retryPolicy?: Partial<RetryPolicy>;
  operationRetryPolicy?: OperationRetryPolicy;
  requestLogger?: RequestLogger;
  fetchImpl?: typeof fetch;
  bodySnippetLength?: number;
  domainFactories?: Partial<DomainFactories>;
};

export class DiscourseService extends DiscourseClient {
  constructor(
    baseUrl: string,
    systemApiKey: string,
    systemUsername: string,
    logger: Logger = noopLogger,
    options: DiscourseServiceOptions = {}
  ) {
    const { domainFactories, ...clientOptions } = options;
    super(baseUrl, systemApiKey, systemUsername, logger, clientOptions);
    const domainServices = createDomainServices(this, domainFactories);
    Object.assign(this, createDomainMethodAdapters(domainServices));
  }

  generateAuthUrl(params: {
    clientId: string;
    applicationName: string;
    nonce: string;
    publicKey: string;
    scopes: string;
  }) {
    return Effect.try(() => {
      const publicKeyEncoded = encodeURIComponent(params.publicKey);
      const scopes = params.scopes?.trim() || "read,write";
      const queryParams = [
        `client_id=${encodeURIComponent(params.clientId)}`,
        `application_name=${encodeURIComponent(params.applicationName)}`,
        `nonce=${encodeURIComponent(params.nonce)}`,
        `scopes=${encodeURIComponent(scopes)}`,
        `public_key=${publicKeyEncoded}`,
      ].join("&");

      const authPath = this.buildUrl("/user-api-key/new");
      return `${authPath}?${queryParams}`;
    });
  }

  checkHealth(options: { timeoutMs?: number } = {}) {
    return Effect.gen(function* (this: DiscourseService) {
      const timeoutMs =
        typeof options.timeoutMs === "number" &&
        Number.isFinite(options.timeoutMs) &&
        options.timeoutMs > 0
          ? options.timeoutMs
          : Math.min(this.defaultTimeoutMs, 2000);

      const probes: Array<{ path: string; method: string; accept: string | null }> = [
        { path: "/site/status", method: "HEAD", accept: null },
        { path: "/site/status", method: "GET", accept: null },
        { path: "/site.json", method: "GET", accept: "application/json" },
      ];

      for (const probe of probes) {
        const succeeded = yield* Effect.tryPromise({
          try: async () => {
            await this.fetchApi<void>(probe.path, {
              method: probe.method,
              accept: probe.accept,
              timeoutMs,
            });
            return true as const;
          },
          catch: (error) => error,
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              this.logger.debug?.("Health probe succeeded", {
                action: "health-check",
                path: probe.path,
                method: probe.method,
              })
            )
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              this.logger.debug?.("Health probe failed", {
                action: "health-check",
                path: probe.path,
                method: probe.method,
                error,
              });
              return false as const;
            })
          )
        );

        if (succeeded) {
          return true;
        }
      }

      this.logger.warn?.("All health probes failed", { action: "health-check", timeoutMs });
      return false;
    }.bind(this));
  }

  // Exposed for tests
  private mapPost(raw: unknown, includeRaw: boolean) {
    return mapPost(raw, includeRaw);
  }

  // Exposed for tests
  private mapCategory(raw: unknown) {
    return mapCategory(raw);
  }

  // Exposed for tests
  private mapTopic(raw: unknown) {
    return mapTopic(raw);
  }

  // Exposed for tests
  private mapRevision(raw: unknown, includeRaw: boolean) {
    return mapRevision(raw, includeRaw);
  }

  // Exposed for tests
  private resolvePostActionType(
    action?: PostActionResult["action"],
    explicitTypeId?: number
  ) {
    return resolvePostActionType(action, explicitTypeId);
  }
}

export interface DiscourseService extends DomainMethodAdapters {}
