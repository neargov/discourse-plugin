import type { Implementer } from "every-plugin/orpc";
import type { DiscourseService } from "../service";
import type { contract } from "../contract";
import type {
  LogFn,
  MakeHandler,
  PluginContext,
  PluginErrorConstructors,
  RunEffect,
} from "../index";
import type { createWithErrorLogging } from "../index";

type Builder = Implementer<typeof contract, PluginContext, PluginContext>;
type WithErrorLogging = ReturnType<typeof createWithErrorLogging>;

export const buildUploadsRouter = (params: {
  builder: Builder;
  discourseService: DiscourseService;
  log: LogFn;
  run: RunEffect;
  withErrorLogging: WithErrorLogging;
  enforceRateLimit: (action: string, errors: PluginErrorConstructors) => void;
}) => {
  const {
    builder,
    discourseService,
    log,
    run,
    withErrorLogging,
    enforceRateLimit,
  } = params;

  return {
    prepareUpload: builder.prepareUpload.handler(async ({ input, errors }) => {
      enforceRateLimit("prepare-upload", errors);
      const resolvedUploadType = input.uploadType ?? "composer";

      return withErrorLogging(
        "prepare-upload",
        async () => {
          const request = discourseService.buildUploadRequest({
            uploadType: resolvedUploadType,
            username: input.username,
            userApiKey: input.userApiKey,
          });

          log("debug", "Prepared upload request", {
            action: "prepare-upload",
            uploadType: resolvedUploadType,
            username: input.username,
          });

          return { request };
        },
        errors,
        { uploadType: resolvedUploadType, username: input.username }
      );
    }),

    presignUpload: builder.presignUpload.handler(async ({ input, errors }) => {
      enforceRateLimit("presign-upload", errors);
      const uploadType = input.uploadType ?? "composer";

      return withErrorLogging(
        "presign-upload",
        async () => {
          const result = await run(
            discourseService.presignUpload({
              filename: input.filename,
              byteSize: input.byteSize,
              contentType: input.contentType,
              uploadType,
              userApiKey: input.userApiKey,
            })
          );

          log("info", "Generated presigned upload", {
            action: "presign-upload",
            uploadType,
            filename: input.filename,
          });

          return result;
        },
        errors,
        { uploadType, filename: input.filename }
      );
    }),

    batchPresignMultipartUpload: builder.batchPresignMultipartUpload.handler(
      async ({ input, errors }) =>
        (enforceRateLimit("batch-presign-multipart-upload", errors),
        withErrorLogging(
          "batch-presign-multipart-upload",
          async () => {
            const result = await run(
              discourseService.batchPresignMultipartUpload({
                uniqueIdentifier: input.uniqueIdentifier,
                partNumbers: input.partNumbers,
                uploadId: input.uploadId,
                key: input.key,
                contentType: input.contentType,
                userApiKey: input.userApiKey,
              })
            );

            log("debug", "Presigned multipart upload parts", {
              action: "batch-presign-multipart-upload",
              parts: input.partNumbers.length,
            });

            return result;
          },
          errors,
          {
            uploadId: input.uploadId,
            key: input.key,
            uniqueIdentifier: input.uniqueIdentifier,
            parts: input.partNumbers.length,
          }
        ))
    ),

    completeMultipartUpload: builder.completeMultipartUpload.handler(
      async ({ input, errors }) => {
        enforceRateLimit("complete-multipart-upload", errors);
        const uploadType = input.uploadType ?? "composer";

        return withErrorLogging(
          "complete-multipart-upload",
          async () => {
            const result = await run(
              discourseService.completeMultipartUpload({
                uniqueIdentifier: input.uniqueIdentifier,
                uploadId: input.uploadId,
                key: input.key,
                parts: input.parts,
                filename: input.filename,
                uploadType,
                userApiKey: input.userApiKey,
              })
            );

            log("info", "Completed multipart upload", {
              action: "complete-multipart-upload",
              uploadId: input.uploadId,
              partCount: input.parts.length,
              uploadType,
            });

            return result;
          },
          errors,
          {
            uploadId: input.uploadId,
            uploadType,
            partCount: input.parts.length,
            filename: input.filename,
          }
        );
      }
    ),

    abortMultipartUpload: builder.abortMultipartUpload.handler(
      async ({ input, errors }) =>
        (enforceRateLimit("abort-multipart-upload", errors),
        withErrorLogging(
          "abort-multipart-upload",
          async () => {
            const aborted = await run(
              discourseService.abortMultipartUpload({
                uniqueIdentifier: input.uniqueIdentifier,
                uploadId: input.uploadId,
                key: input.key,
                userApiKey: input.userApiKey,
              })
            );

            log("warn", "Aborted multipart upload", {
              action: "abort-multipart-upload",
              uploadId: input.uploadId,
              aborted,
            });

            return { aborted };
          },
          errors,
          {
            uploadId: input.uploadId,
            key: input.key,
            uniqueIdentifier: input.uniqueIdentifier,
          }
        ))
    ),
  };
};
