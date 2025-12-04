import type { Implementer } from "every-plugin/orpc";
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

  const resolve = async <T>(value: unknown): Promise<T> => {
    if (value && typeof (value as any).then === "function") {
      return value as Promise<T>;
    }
    return run(value as any);
  };

  const requireBadRequest = (errors: PluginErrorConstructors) => {
    if (!errors.BAD_REQUEST) {
      throw new RouterConfigError("BAD_REQUEST constructor missing");
    }
    return errors.BAD_REQUEST;
  };

  const getActiveNonceOrThrow = (
    nonce: string,
    clientId: string | undefined,
    errors: PluginErrorConstructors
  ) => {
    const badRequest = requireBadRequest(errors);
    const nonceData = nonceManager.get(nonce);
    if (!nonceData) {
      logNonceLookup({
        status: "missing",
        nonceSuffix: nonce.slice(-6),
      });
      throw badRequest({
        message: "Invalid or expired nonce",
        data: {},
      });
    }
    const verified = nonceManager.verify(nonce, nonceData.clientId);
    const normalizedClientId = typeof clientId === "string" ? clientId.trim() : "";
    const clientIdMatch =
      normalizedClientId.length === 0 || nonceData.clientId === normalizedClientId;

    logNonceLookup({
      status: verified && clientIdMatch ? "verified" : "invalid",
      nonceSuffix: nonce.slice(-6),
      clientId: nonceData.clientId,
      providedClientId: clientId,
    });
    if (!verified || !clientIdMatch) {
      throw badRequest({
        message: "Invalid or expired nonce",
        data: {},
      });
    }
    return nonceData;
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
        const nonceData = getActiveNonceOrThrow(input.nonce, input.clientId, errors);

        try {
          let userApiKey: string;
          try {
            userApiKey = await resolve<string>(
              cryptoService.decryptPayload(input.payload, nonceData.privateKey)
            );
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

          const discourseUser = await resolve<Awaited<ReturnType<typeof discourseService.getCurrentUser>>>(
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
        const result = await resolve<Awaited<ReturnType<typeof discourseService.validateUserApiKey>>>(
          discourseService.validateUserApiKey(input.userApiKey)
        );

        return mapValidateUserApiKeyResult(result, errors);
      })
    ),
  };
};
