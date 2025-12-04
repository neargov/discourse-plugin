import type { Implementer } from "every-plugin/orpc";
import type { DiscourseService } from "../service";
import type { contract } from "../contract";
import type {
  PluginContext,
  LogFn,
  RunEffect,
  MakeHandler,
  PluginErrorConstructors,
} from "../index";

type Builder = Implementer<typeof contract, PluginContext, PluginContext>;
type RouterConfigErrorCtor = typeof import("../index").RouterConfigError;

export const buildPostsRouter = (params: {
  builder: Builder;
  discourseService: DiscourseService;
  log: LogFn;
  run: RunEffect;
  makeHandler: MakeHandler;
  withCache?: <T>(params: { action: string; key: string; fetch: () => Promise<T> }) => Promise<T>;
  invalidateCache?: (keys: string[]) => void;
  invalidateCacheByPrefix?: (prefixes: string[]) => void;
  RouterConfigError?: RouterConfigErrorCtor;
}) => {
  const {
    builder,
    discourseService,
    log,
    run,
    makeHandler,
    withCache,
    invalidateCache,
    invalidateCacheByPrefix,
    RouterConfigError = Error as RouterConfigErrorCtor,
  } = params;

  const resolvedWithCache =
    withCache ??
    (async <T>(params: { fetch: () => Promise<T> }) => {
      return params.fetch();
    });

  const invalidate = (keys: string[]) => invalidateCache?.(keys);
  const invalidateByPrefix = (prefixes: string[]) =>
    invalidateCacheByPrefix?.(prefixes);

  const invalidatePostCaches = (postId: number | undefined, topicId?: number) => {
    if (typeof postId === "number") {
      invalidate([
        `post:${postId}:raw:false`,
        `post:${postId}:raw:true`,
        `post:${postId}:replies`,
      ]);
    }
    invalidateByPrefix(["posts:list:"]);

    if (typeof topicId === "number") {
      invalidate([`topic:${topicId}`]);
    }
    invalidateByPrefix(["topics:latest:", "topics:list:", "topics:top:", "topics:category:"]);
  };

  const requireServiceUnavailable = (errors: PluginErrorConstructors) => {
    const serviceUnavailable = errors.SERVICE_UNAVAILABLE;
    if (!serviceUnavailable) {
      throw new RouterConfigError("SERVICE_UNAVAILABLE constructor missing");
    }
    return serviceUnavailable;
  };

  return {
    createPost: builder.createPost.handler(
      makeHandler("create-post", async ({ input, errors }) => {
        const serviceUnavailable = requireServiceUnavailable(errors);

        const postData = await run(
          discourseService.createPost({
            title: input.title,
            raw: input.raw,
            category: input.category,
            username: input.username,
            topicId: input.topicId,
            replyToPostNumber: input.replyToPostNumber,
            userApiKey: input.userApiKey,
          })
        );

        if (
          typeof postData.topic_id !== "number" ||
          typeof postData.topic_slug !== "string" ||
          typeof postData.id !== "number"
        ) {
          throw serviceUnavailable({
            message: "Discourse response missing topic_slug/topic_id",
            data: {
              topicId: postData.topic_id,
              topicSlug: postData.topic_slug,
            },
          });
        }

        log("info", "Created Discourse post", {
          action: "create-post",
          discourseUsername: input.username,
          topicId: postData.topic_id,
          postId: postData.id,
        });

        invalidatePostCaches(postData.id, postData.topic_id);

        return {
          success: true,
          postUrl: discourseService.resolvePath(
            `/t/${postData.topic_slug}/${postData.topic_id}`
          ),
          postId: postData.id,
          topicId: postData.topic_id,
        };
      })
    ),

    editPost: builder.editPost.handler(
      makeHandler("edit-post", async ({ input, errors }) => {
        const serviceUnavailable = requireServiceUnavailable(errors);

        const postData = await run(
          discourseService.editPost({
            postId: input.postId,
            raw: input.raw,
            username: input.username,
            editReason: input.editReason,
            userApiKey: input.userApiKey,
          })
        );

        if (
          typeof postData.topicId !== "number" ||
          typeof postData.topicSlug !== "string" ||
          typeof postData.id !== "number"
        ) {
          throw serviceUnavailable({
            message: "Discourse response missing topicSlug/topicId",
            data: {
              topicId: postData.topicId,
              topicSlug: postData.topicSlug,
            },
          });
        }

        const postUrl = discourseService.resolvePath(
          postData.postUrl || `/p/${postData.id}`
        );

        log("info", "Edited Discourse post", {
          action: "edit-post",
          discourseUsername: input.username,
          postId: postData.id,
          topicId: postData.topicId,
        });

        invalidatePostCaches(postData.id, postData.topicId);

        return {
          success: true,
          postUrl,
          postId: postData.id,
          topicId: postData.topicId,
        };
      })
    ),

    lockPost: builder.lockPost.handler(
      makeHandler("lock-post", async ({ input }) => {
        const result = await run(
          discourseService.lockPost({
            postId: input.postId,
            locked: input.locked,
            username: input.username,
            userApiKey: input.userApiKey,
          })
        );

        log("info", "Updated Discourse post lock", {
          action: "lock-post",
          postId: input.postId,
          locked: result.locked,
          discourseUsername: input.username,
        });

        invalidatePostCaches(input.postId);

        return result;
      })
    ),

    performPostAction: builder.performPostAction.handler(
      makeHandler("perform-post-action", async ({ input }) => {
        const result = await run(
          discourseService.performPostAction({
            postId: input.postId,
            action: input.action,
            postActionTypeId: input.postActionTypeId,
            message: input.message,
            mode: input.mode,
            username: input.username,
            userApiKey: input.userApiKey,
          })
        );

        log("info", "Performed Discourse post action", {
          action: "perform-post-action",
          postId: input.postId,
          postActionTypeId: result.postActionTypeId,
          postActionId: result.postActionId,
          actionName: result.action,
          discourseUsername: input.username,
        });

        invalidatePostCaches(input.postId);

        return result;
      })
    ),

    deletePost: builder.deletePost.handler(
      makeHandler(
        "delete-post",
        async ({ input }) => {
          const forceDestroy = input.forceDestroy === true;

          const result = await run(
            discourseService.deletePost({
              postId: input.postId,
              forceDestroy,
              username: input.username,
              userApiKey: input.userApiKey,
            })
          );

          log("info", "Deleted Discourse post", {
            action: "delete-post",
            postId: input.postId,
            forceDestroy,
            discourseUsername: input.username,
          });

          invalidatePostCaches(input.postId);

          return result;
        },
        (input) => ({
          postId: input.postId,
          forceDestroy: input.forceDestroy === true,
          discourseUsername: input.username,
        })
      )
    ),

    getPost: builder.getPost.handler(
      makeHandler("get-post", async ({ input }) => {
        const result = await resolvedWithCache({
          action: "get-post",
          key: `post:${input.postId}:raw:${input.includeRaw ?? false}`,
          fetch: async () =>
            run(discourseService.getPost(input.postId, input.includeRaw)),
        });
        log("debug", "Fetched post", {
          action: "get-post",
          postId: input.postId,
          includeRaw: input.includeRaw,
        });
        return result;
      })
    ),

    listPosts: builder.listPosts.handler(
      makeHandler("list-posts", async ({ input }) => {
        const result = await resolvedWithCache({
          action: "list-posts",
          key: `posts:list:${input.page ?? 0}`,
          fetch: async () => run(discourseService.listPosts({ page: input.page })),
        });
        log("debug", "Fetched posts", {
          action: "list-posts",
          page: input.page,
        });
        return result;
      })
    ),

    getPostReplies: builder.getPostReplies.handler(
      makeHandler("get-post-replies", async ({ input }) => {
        const replies = await resolvedWithCache({
          action: "get-post-replies",
          key: `post:${input.postId}:replies`,
          fetch: async () => run(discourseService.getPostReplies(input.postId)),
        });
        log("debug", "Fetched post replies", {
          action: "get-post-replies",
          postId: input.postId,
        });
        return { replies };
      })
    ),

    getRevision: builder.getRevision.handler(
      makeHandler("get-revision", async ({ input }) => {
        const result = await run(
          discourseService.getRevision({
            postId: input.postId,
            revision: input.revision,
            includeRaw: input.includeRaw,
            username: input.username,
            userApiKey: input.userApiKey,
          })
        );
        log("debug", "Fetched post revision", {
          action: "get-revision",
          postId: input.postId,
          revision: input.revision,
          includeRaw: input.includeRaw,
        });
        return result;
      })
    ),

    updateRevision: builder.updateRevision.handler(
      makeHandler("update-revision", async ({ input }) => {
        const result = await run(
          discourseService.updateRevision({
            postId: input.postId,
            revision: input.revision,
            raw: input.raw,
            editReason: input.editReason,
            username: input.username,
            userApiKey: input.userApiKey,
          })
        );
        log("info", "Updated post revision", {
          action: "update-revision",
          postId: input.postId,
          revision: input.revision,
          discourseUsername: input.username,
        });

        invalidatePostCaches(input.postId);
        return result;
      })
    ),

    deleteRevision: builder.deleteRevision.handler(
      makeHandler("delete-revision", async ({ input }) => {
        const result = await run(
          discourseService.deleteRevision({
            postId: input.postId,
            revision: input.revision,
            username: input.username,
            userApiKey: input.userApiKey,
          })
        );
        log("info", "Deleted post revision", {
          action: "delete-revision",
          postId: input.postId,
          revision: input.revision,
          discourseUsername: input.username,
        });

        invalidatePostCaches(input.postId);
        return result;
      })
    ),
  };
};
