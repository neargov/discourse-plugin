import { CommonPluginErrors } from "every-plugin";
import { oc } from "every-plugin/orpc";
import { z } from "every-plugin/zod";
import {
  AuthUrlSchema,
  CompleteLinkResultSchema,
  NonEmptyString,
  OptionalUserApiKeySchema,
  RequiredUsernameSchema,
  ValidateUserApiKeyResultSchema,
} from "../schemas";

export const authRoutes = {
  initiateLink: oc
    .route({ method: "POST", path: "/auth/initiate" })
    .input(
      z.object({
        clientId: NonEmptyString.min(1, "Client ID is required"),
        applicationName: NonEmptyString.min(1, "Application name is required"),
      }).describe("Generate a Discourse authorization URL for a client")
    )
    .output(AuthUrlSchema.describe("Authorization URL and nonce for Discourse linking"))
    .errors(CommonPluginErrors),

  completeLink: oc
    .route({ method: "POST", path: "/auth/complete" })
    .input(
      z.object({
        payload: NonEmptyString.min(1, "Encrypted payload is required"),
        nonce: NonEmptyString.min(1, "Nonce is required"),
      }).describe("Complete Discourse linking by decrypting the payload with the nonce")
    )
    .output(
      CompleteLinkResultSchema.describe(
        "Linked Discourse user details and user API key after successful verification"
      )
    )
    .errors(CommonPluginErrors),

  forgotPassword: oc
    .route({ method: "POST", path: "/auth/forgot" })
    .input(
      z
        .object({ login: NonEmptyString })
        .describe("Username or email used to initiate Discourse password reset")
    )
    .output(
      z.object({ success: z.boolean() }).describe("Indicates whether reset email was accepted")
    )
    .errors(CommonPluginErrors),

  changePassword: oc
    .route({ method: "POST", path: "/auth/password/change" })
    .input(
      z.object({
        token: NonEmptyString,
        password: z.string().min(8),
      }).describe("Password reset token and the new password")
    )
    .output(
      z.object({ success: z.boolean() }).describe("Whether the password change succeeded")
    )
    .errors(CommonPluginErrors),

  logoutUser: oc
    .route({ method: "POST", path: "/auth/logout" })
    .input(
      z.object({ userId: z.number().int().positive() }).describe("Discourse user id to log out")
    )
    .output(z.object({ success: z.boolean() }).describe("Logout success status"))
    .errors(CommonPluginErrors),

  syncSso: oc
    .route({ method: "POST", path: "/auth/sso/sync" })
    .input(
      z.object({
        sso: NonEmptyString,
        sig: NonEmptyString,
      }).describe("Discourse SSO payload and signature to sync user state")
    )
    .output(
      z.object({
        success: z.boolean(),
        userId: z.number().int().optional(),
      }).describe("SSO sync outcome and optional Discourse user id")
    )
    .errors(CommonPluginErrors),

  validateUserApiKey: oc
    .route({ method: "POST", path: "/auth/validate" })
    .input(
      z.object({ userApiKey: NonEmptyString }).describe("User API key to validate with Discourse")
    )
    .output(
      ValidateUserApiKeyResultSchema.describe(
        "Validation result for the provided Discourse user API key"
      )
    )
    .errors(CommonPluginErrors),
};
