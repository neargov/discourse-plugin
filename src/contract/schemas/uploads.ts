import { z } from "every-plugin/zod";
import {
  NonEmptyString,
  NonNegativeIntSchema,
  OptionalUserApiKeySchema,
  OptionalUsernameSchema,
  PositiveIntSchema,
  UploadTypeSchema,
  UniquePositiveIntArraySchema,
} from "./base";

export const UploadSchema = z.object({
  id: PositiveIntSchema,
  url: z.string(),
  shortUrl: z.string().optional(),
  originalFilename: z.string().optional(),
  filesize: NonNegativeIntSchema.optional(),
  humanFileSize: z.string().optional(),
  extension: z.string().optional(),
  width: NonNegativeIntSchema.optional(),
  height: NonNegativeIntSchema.optional(),
  thumbnailUrl: z.string().optional(),
});

export const UploadRequestSchema = z.object({
  url: z.string(),
  method: z.literal("POST"),
  headers: z.record(z.string(), z.string()),
  fields: z.record(z.string(), z.string()),
});

export const PresignedUploadSchema = z.object({
  method: z.literal("PUT"),
  uploadUrl: z.string(),
  headers: z.record(z.string(), z.string()),
  key: NonEmptyString,
  uniqueIdentifier: NonEmptyString,
});

export const MultipartPresignPartSchema = z.object({
  partNumber: PositiveIntSchema,
  url: z.string(),
  headers: z.record(z.string(), z.string()),
});

export const MultipartPresignSchema = z.object({
  uploadId: NonEmptyString,
  key: NonEmptyString,
  uniqueIdentifier: NonEmptyString,
  parts: z.array(MultipartPresignPartSchema).nonempty(),
});

export const PrepareUploadInputSchema = z.object({
  uploadType: UploadTypeSchema,
  username: OptionalUsernameSchema,
  userApiKey: OptionalUserApiKeySchema,
});

export const PresignUploadInputSchema = z.object({
  filename: NonEmptyString,
  byteSize: PositiveIntSchema,
  contentType: z.string().optional(),
  uploadType: UploadTypeSchema,
  userApiKey: OptionalUserApiKeySchema,
});

export const BatchPresignMultipartInputSchema = z.object({
  uniqueIdentifier: NonEmptyString,
  partNumbers: UniquePositiveIntArraySchema,
  uploadId: NonEmptyString.optional(),
  key: NonEmptyString.optional(),
  contentType: z.string().optional(),
  userApiKey: OptionalUserApiKeySchema,
});

export const CompleteMultipartUploadInputSchema = z.object({
  uniqueIdentifier: NonEmptyString,
  uploadId: NonEmptyString,
  key: NonEmptyString,
  parts: z
    .array(
      z.object({
        partNumber: PositiveIntSchema,
        etag: NonEmptyString,
      })
    )
    .nonempty()
    .superRefine((parts, ctx) => {
      const seen = new Set<number>();
      for (const part of parts) {
        if (seen.has(part.partNumber)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "partNumbers must be unique",
            path: ["parts"],
          });
          return;
        }
        seen.add(part.partNumber);
      }
    }),
  filename: NonEmptyString,
  uploadType: UploadTypeSchema,
  userApiKey: OptionalUserApiKeySchema,
});

export const AbortMultipartUploadInputSchema = z.object({
  uniqueIdentifier: NonEmptyString,
  uploadId: NonEmptyString,
  key: NonEmptyString,
  userApiKey: OptionalUserApiKeySchema,
});
