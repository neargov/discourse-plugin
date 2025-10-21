import { createPlugin } from "every-plugin";
import { Effect } from "every-plugin/effect";
import { z } from "every-plugin/zod";
import { contract } from "./contract";
import {
  DiscourseService,
  CryptoService,
  NEARService,
  NonceManager,
  LinkageStore,
} from "./service";

/**
 * Discourse Plugin
 *
 * Enables NEAR account holders to connect and interact with forums
 *
 * Shows how to:
 * - Link NEAR accounts to Discourse usernames
 * - Verify on-chain message signatures (NEP-413)
 * - Create posts on behalf of users via API calls
 * - Manage RSA encryption for secure key exchange
 */

export default createPlugin({
  id: "@neargov/discourse-plugin",

  variables: z.object({
    discourseBaseUrl: z.string().url(),
    discourseApiUsername: z.string().default("system"),
    clientId: z.string().default("discourse-near-plugin"),
    recipient: z.string().default("social.near"),
  }),

  secrets: z.object({
    discourseApiKey: z.string().min(1, "Discourse System API key is required"),
  }),

  contract,

  initialize: (config) =>
    Effect.gen(function* () {
      // Create service instances with config
      const discourseService = new DiscourseService(
        config.variables.discourseBaseUrl,
        config.secrets.discourseApiKey,
        config.variables.discourseApiUsername
      );

      const cryptoService = new CryptoService();
      const nearService = new NEARService(config.variables.recipient);
      const nonceManager = new NonceManager();
      const linkageStore = new LinkageStore();

      // Start background cleanup task for expired nonces
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("5 minutes");
            nonceManager.cleanup();
          }
        })
      );

      return {
        discourseService,
        cryptoService,
        nearService,
        nonceManager,
        linkageStore,
        config,
      };
    }),

  shutdown: () => Effect.void,

  createRouter: (context, builder) => {
    const {
      discourseService,
      cryptoService,
      nearService,
      nonceManager,
      linkageStore,
      config,
    } = context;

    return {
      getUserApiAuthUrl: builder.getUserApiAuthUrl.handler(
        async ({ input }) => {
          const { publicKey, privateKey } = await Effect.runPromise(
            cryptoService.generateKeyPair()
          );

          const nonce = nonceManager.create(input.clientId, privateKey);

          const authUrl = await Effect.runPromise(
            discourseService.generateAuthUrl({
              clientId: input.clientId,
              applicationName: input.applicationName,
              nonce,
              publicKey,
            })
          );

          return { authUrl, nonce };
        }
      ),

      completeLink: builder.completeLink.handler(async ({ input, errors }) => {
        const nonceData = nonceManager.get(input.nonce);
        if (!nonceData) {
          throw errors.BAD_REQUEST({
            message: "Invalid or expired nonce",
            data: {},
          });
        }

        if (!nonceManager.verify(input.nonce, nonceData.clientId)) {
          throw errors.BAD_REQUEST({
            message: "Invalid or expired nonce",
            data: {},
          });
        }

        const userApiKey = await Effect.runPromise(
          cryptoService.decryptPayload(input.payload, nonceData.privateKey)
        );

        const discourseUser = await Effect.runPromise(
          discourseService.getCurrentUser(userApiKey)
        );

        const nearAccount = await Effect.runPromise(
          nearService.verifySignature(input.authToken)
        );

        linkageStore.set(nearAccount, {
          nearAccount,
          discourseUsername: discourseUser.username,
          discourseUserId: discourseUser.id,
          userApiKey,
          verifiedAt: new Date().toISOString(),
        });

        nonceManager.consume(input.nonce);

        return {
          success: true,
          nearAccount,
          discourseUsername: discourseUser.username,
          message: `Successfully linked ${nearAccount} to ${discourseUser.username}`,
        };
      }),

      createPost: builder.createPost.handler(async ({ input, errors }) => {
        const nearAccount = await Effect.runPromise(
          nearService.verifySignature(input.authToken, 300000)
        );

        const linkage = linkageStore.get(nearAccount);
        if (!linkage) {
          throw errors.FORBIDDEN({
            message:
              "No linked Discourse account. Please link your account first.",
            data: {
              requiredPermissions: ["linked-account"],
              action: "create-post",
            },
          });
        }

        const postData = await Effect.runPromise(
          discourseService.createPost({
            title: input.title,
            raw: input.raw,
            category: input.category,
            username: linkage.discourseUsername,
          })
        );

        return {
          success: true,
          postUrl: `${config.variables.discourseBaseUrl}/t/${postData.topic_slug}/${postData.topic_id}`,
          postId: postData.id,
          topicId: postData.topic_id,
        };
      }),

      getLinkage: builder.getLinkage.handler(async ({ input }) => {
        const linkage = linkageStore.get(input.nearAccount);

        if (!linkage) {
          return null;
        }

        return {
          nearAccount: linkage.nearAccount,
          discourseUsername: linkage.discourseUsername,
          verifiedAt: linkage.verifiedAt,
        };
      }),

      ping: builder.ping.handler(async () => {
        return {
          status: "ok" as const,
          timestamp: new Date().toISOString(),
          discourseConnected: true,
        };
      }),
    };
  },
});
