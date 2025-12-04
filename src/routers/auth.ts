import type { Implementer } from "every-plugin/orpc";
import type { Effect } from "every-plugin/effect";
import type { CryptoService, DiscourseService, NonceManager } from "../service";
import type { contract } from "../contract";
import type {
  LogFn,
  MakeHandler,
  PluginContext,
  RunEffect,
} from "../index";
import type { PluginErrorConstructors } from "../plugin-errors";
import type { NormalizedUserApiScopes } from "../plugin-config";

type RouterConfigErrorCtor = typeof import("../index").RouterConfigError;
type SanitizeErrorForLog = typeof import("../plugin-errors").sanitizeErrorForLog;
type MapValidateUserApiKeyResult = typeof import("../plugin-config").mapValidateUserApiKeyResult;

type Builder = Implementer<typeof contract, PluginContext, PluginContext>;

export const buildAuthRouter = (params: {
  builder: Builder;
  cryptoService: CryptoService;
  discourseService: DiscourseService;
  nonceManager: NonceManager;
  normalizedUserApiScopes: NormalizedUserApiScopes;
  log: LogFn;
  run: RunEffect;
  makeHandler: MakeHandler;
  sanitizeErrorForLog: SanitizeErrorForLog;
  mapValidateUserApiKeyResult: MapValidateUserApiKeyResult;
  RouterConfigError: RouterConfigErrorCtor;
}) => {
  const {
    builder,
    cryptoService,
    discourseService,
    nonceManager,
    normalizedUserApiScopes,
    log,
    run,
    makeHandler,
    sanitizeErrorForLog,
    mapValidateUserApiKeyResult,
    RouterConfigError,
  } = params;

  const logNonceLookup = (meta: Record<string, unknown>) =>
    log("debug", "Nonce lookup", {
      action: "nonce-lookup",
      ...meta,
    });

  const resolveAsync = <T>(value: Promise<T> | Effect.Effect<T, any, never>) =>
    value && typeof (value as any).then === "function"
      ? (value as Promise<T>)
      : run(value as Effect.Effect<T, any, never>);

  const requireBadRequest = (errors: PluginErrorConstructors) => {
    if (!errors.BAD_REQUEST) {
      throw new RouterConfigError("BAD_REQUEST constructor missing");
    }
    return errors.BAD_REQUEST;
  };

  return {
    initiateLink: builder.initiateLink.handler(
      makeHandler("initiate-link", async ({ input, errors }) => {
        const { publicKey, privateKey } = await run(cryptoService.generateKeyPair());

        const nonce = nonceManager.create(input.clientId, privateKey);

        const authUrl = await run(
          discourseService.generateAuthUrl({
            clientId: input.clientId,
            applicationName: input.applicationName,
            nonce,
            publicKey,
            scopes: normalizedUserApiScopes.joined,
          })
        );

        const expiresAt = nonceManager.getExpiration(nonce);
        if (!expiresAt) {
          throw requireBadRequest(errors)({
            message: "Failed to compute nonce expiration",
            data: {},
          });
        }

        log("info", "Generated Discourse auth URL", {
          action: "initiate-link",
          clientId: input.clientId,
          applicationName: input.applicationName,
          expiresAt,
        });

        return {
          authUrl,
          nonce,
          expiresAt: new Date(expiresAt).toISOString(),
        };
      })
    ),

    completeLink: builder.completeLink.handler(
      makeHandler("complete-link", async ({ input, errors }) => {
        const badRequest = requireBadRequest(errors);
        const nonceData = nonceManager.get(input.nonce);
        if (!nonceData) {
          logNonceLookup({
            status: "missing",
            nonceSuffix: input.nonce.slice(-6),
          });
          throw badRequest({
            message: "Invalid or expired nonce",
            data: {},
          });
        }

        const normalizedClientId =
          typeof input.clientId === "string" ? input.clientId.trim() : "";

        if (normalizedClientId && nonceData.clientId !== normalizedClientId) {
          logNonceLookup({
            status: "invalid",
            nonceSuffix: input.nonce.slice(-6),
            clientId: nonceData.clientId,
            providedClientId: input.clientId,
          });
          throw badRequest({
            message: "Invalid or expired nonce",
            data: {},
          });
        }

        const verified = nonceManager.verify(input.nonce, nonceData.clientId);

        logNonceLookup({
          status: verified ? "verified" : "invalid",
          nonceSuffix: input.nonce.slice(-6),
          clientId: nonceData.clientId,
          providedClientId: input.clientId,
        });
        if (!verified) {
          throw badRequest({
            message: "Invalid or expired nonce",
            data: {},
          });
        }

        try {
          let userApiKey: string;
          try {
            const decrypted = cryptoService.decryptPayload(
              input.payload,
              nonceData.privateKey
            );
            userApiKey = await resolveAsync(decrypted);
          } catch (error) {
            log("warn", "Failed to decrypt Discourse payload", {
              action: "complete-link",
              error: sanitizeErrorForLog(error),
            });
            throw requireBadRequest(errors)({
              message: "Invalid or expired payload",
              data: {},
            });
          }

          const discourseUser = await resolveAsync(
            discourseService.getCurrentUser(userApiKey)
          );

          log("info", "Completed Discourse link", {
            action: "complete-link",
            discourseUser: discourseUser.username,
          });

          return {
            userApiKey,
            discourseUsername: discourseUser.username,
            discourseUserId: discourseUser.id,
          };
        } finally {
          nonceManager.consume(input.nonce);
        }
      })
    ),

    validateUserApiKey: builder.validateUserApiKey.handler(
      makeHandler("validate-user-api-key", async ({ input, errors }) => {
        const result = await run(
          discourseService.validateUserApiKey(input.userApiKey)
        );

        return mapValidateUserApiKeyResult(result, errors);
      })
    ),
  };
};
