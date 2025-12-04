import { CommonPluginErrors } from "every-plugin";
import { oc } from "every-plugin/orpc";
import { z } from "every-plugin/zod";
import {
  DeletePostInputSchema,
  DeleteRevisionInputSchema,
  EditPostInputSchema,
  PaginatedPostsSchema,
  PostActionInputSchema,
  PostActionResultSchema,
  PostGetInputSchema,
  PostInputSchema,
  PostListInputSchema,
  PostRepliesInputSchema,
  PostResultSchema,
  PostSchema,
  RevisionInputSchema,
  RevisionSchema,
  UpdateRevisionInputSchema,
  LockPostInputSchema,
} from "../schemas";
import { TopicSchema } from "../schemas/topics";

export const postsRoutes = {
  createPost: oc
    .route({ method: "POST", path: "/posts/create" })
    .input(
      PostInputSchema.describe(
        "Create a Discourse post or topic using the provided raw markdown content"
      )
    )
    .output(
      PostResultSchema.describe(
        "Result of creating a post, including the post URL and identifiers"
      )
    )
    .errors(CommonPluginErrors),

  editPost: oc
    .route({ method: "POST", path: "/posts/edit" })
    .input(EditPostInputSchema.describe("Edit an existing post's raw markdown content"))
    .output(PostResultSchema.describe("Result of editing a post with updated identifiers"))
    .errors(CommonPluginErrors),

  lockPost: oc
    .route({ method: "POST", path: "/posts/lock" })
    .input(LockPostInputSchema.describe("Lock or unlock a post for further edits"))
    .output(z.object({ locked: z.boolean() }).describe("Indicates whether the post is locked"))
    .errors(CommonPluginErrors),

  performPostAction: oc
    .route({ method: "POST", path: "/posts/action" })
    .input(
      PostActionInputSchema.describe(
        "Perform a post action such as like, flag, or undo using the specified mode"
      )
    )
    .output(PostActionResultSchema.describe("Outcome of performing the requested post action"))
    .errors(CommonPluginErrors),

  deletePost: oc
    .route({ method: "POST", path: "/posts/delete" })
    .input(DeletePostInputSchema.describe("Delete a post, optionally forcing destruction"))
    .output(z.object({ success: z.boolean() }).describe("Indicates whether the post was deleted"))
    .errors(CommonPluginErrors),

  getPost: oc
    .route({ method: "POST", path: "/posts/get" })
    .input(PostGetInputSchema.describe("Retrieve a post and its topic by post id"))
    .output(
      z.object({
        post: PostSchema,
        topic: TopicSchema,
      }).describe("Post details with the associated topic")
    )
    .errors(CommonPluginErrors),

  getPostReplies: oc
    .route({ method: "POST", path: "/posts/replies" })
    .input(PostRepliesInputSchema.describe("List replies for a specific post"))
    .output(
      z.object({ replies: z.array(PostSchema) }).describe("Replies mapped to normalized post data")
    )
    .errors(CommonPluginErrors),

  listPosts: oc
    .route({ method: "POST", path: "/posts/list" })
    .input(PostListInputSchema.describe("List latest posts with pagination"))
    .output(PaginatedPostsSchema.describe("Paginated list of posts with next page indicator"))
    .errors(CommonPluginErrors),

  getRevision: oc
    .route({ method: "POST", path: "/posts/revisions/get" })
    .input(
      RevisionInputSchema.extend({
        includeRaw: z.boolean().default(false),
        username: z.string().optional(),
        userApiKey: z.string().optional(),
      }).describe("Fetch a specific post revision with optional raw content")
    )
    .output(
      z
        .object({ revision: RevisionSchema })
        .describe("Normalized post revision with optional raw content")
    )
    .errors(CommonPluginErrors),

  updateRevision: oc
    .route({ method: "POST", path: "/posts/revisions/update" })
    .input(UpdateRevisionInputSchema.describe("Update a post revision's raw content and reason"))
    .output(z.object({ revision: RevisionSchema }).describe("Updated revision payload"))
    .errors(CommonPluginErrors),

  deleteRevision: oc
    .route({ method: "POST", path: "/posts/revisions/delete" })
    .input(DeleteRevisionInputSchema.describe("Delete a specific post revision"))
    .output(
      z.object({ success: z.boolean() }).describe("Indicates whether the revision was deleted")
    )
    .errors(CommonPluginErrors),
};
