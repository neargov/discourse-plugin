import { CommonPluginErrors } from "every-plugin";
import { oc } from "every-plugin/orpc";
import { z } from "every-plugin/zod";

/**
 * Discourse NEAR Plugin Contract
 *
 * Enables NEAR account holders to connect and interact with forums
 */

// Schema for linkage information
export const LinkageSchema = z.object({
  nearAccount: z.string(),
  discourseUsername: z.string(),
  verifiedAt: z.string().datetime(),
});

// Schema for auth URL response
export const AuthUrlSchema = z.object({
  authUrl: z.string().url(),
  nonce: z.string(),
});

// Schema for link completion response
export const LinkResultSchema = z.object({
  success: z.boolean(),
  nearAccount: z.string(),
  discourseUsername: z.string(),
  message: z.string(),
});

// Schema for post creation result
export const PostResultSchema = z.object({
  success: z.boolean(),
  postUrl: z.string().url().optional(),
  postId: z.number().optional(),
  topicId: z.number().optional(),
});

// oRPC Contract definition
export const contract = oc.router({
  // Step 1: Generate User API auth URL for Discourse
  getUserApiAuthUrl: oc
    .route({ method: "POST", path: "/auth/user-api-url" })
    .input(
      z.object({
        clientId: z.string().min(1, "Client ID is required"),
        applicationName: z.string().min(1, "Application name is required"),
      })
    )
    .output(AuthUrlSchema)
    .errors(CommonPluginErrors),

  // Step 2: Complete link between NEAR account and Discourse user
  completeLink: oc
    .route({ method: "POST", path: "/auth/complete" })
    .input(
      z.object({
        payload: z.string().min(1, "Encrypted payload is required"), // Encrypted User API key from Discourse (base64)
        nonce: z.string().min(1, "Nonce is required"),
        authToken: z.string().min(1, "NEAR auth token is required"), // NEAR NEP-413 signature
      })
    )
    .output(LinkResultSchema)
    .errors(CommonPluginErrors),

  // Step 3: Create a Discourse post (requires linked account)
  createPost: oc
    .route({ method: "POST", path: "/posts/create" })
    .input(
      z.object({
        authToken: z.string().min(1, "NEAR auth token is required"), // NEAR signature for verification
        title: z.string().min(15, "Title must be at least 15 characters"),
        raw: z.string().min(20, "Post content must be at least 20 characters"),
        category: z.number().int().positive().optional(),
      })
    )
    .output(PostResultSchema)
    .errors(CommonPluginErrors),

  // Get linkage information for a NEAR account
  getLinkage: oc
    .route({ method: "POST", path: "/linkage/get" })
    .input(
      z.object({
        nearAccount: z.string().min(1, "NEAR account is required"),
      })
    )
    .output(LinkageSchema.nullable())
    .errors(CommonPluginErrors),

  // Health check procedure
  ping: oc
    .route({ method: "GET", path: "/ping" })
    .output(
      z.object({
        status: z.literal("ok"),
        timestamp: z.string().datetime(),
        discourseConnected: z.boolean(),
      })
    )
    .errors(CommonPluginErrors),
});
