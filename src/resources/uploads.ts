import { z } from "every-plugin/zod";
import type {
  MultipartPresign,
  PresignedUpload,
  Upload,
  UploadRequest,
} from "../contract";
import type { ResourceClient } from "../client";
import { runWithContext } from "../client";
import { DEFAULT_UPLOAD_TYPE } from "../constants";
import { normalizeHeaderValues, parseWithSchema, parseWithSchemaOrThrow } from "./shared";

export const RawUploadSchema = z.object({
  id: z.number(),
  url: z.string(),
  short_url: z.string().optional(),
  short_path: z.string().optional(),
  original_filename: z.string().optional(),
  filesize: z.number().optional(),
  human_filesize: z.string().optional(),
  extension: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  thumbnail_url: z.string().optional(),
});

export const RawPresignedUploadSchema = z.object({
  key: z.string(),
  url: z.string().optional(),
  upload_url: z.string().optional(),
  headers: z.record(z.string(), z.any()).default({}),
  unique_identifier: z.string(),
});

export const RawMultipartPresignSchema = z.object({
  upload_id: z.string(),
  key: z.string(),
  unique_identifier: z.string(),
  presigned_urls: z
    .array(
      z.object({
        part_number: z.number().int().positive(),
        url: z.string(),
        headers: z.record(z.string(), z.any()).default({}),
      })
    )
    .default([]),
});

export const RawAbortUploadSchema = z.object({
  success: z.boolean().optional(),
  aborted: z.boolean().optional(),
});

export const mapUpload = (upload: any): Upload => {
  const parsed = parseWithSchemaOrThrow(
    RawUploadSchema,
    upload,
    "Upload",
    "Malformed upload response"
  );

  return {
    id: parsed.id,
    url: parsed.url,
    shortUrl: parsed.short_url ?? parsed.short_path ?? undefined,
    originalFilename: parsed.original_filename,
    filesize: parsed.filesize,
    humanFileSize: parsed.human_filesize,
    extension: parsed.extension,
    width: parsed.width,
    height: parsed.height,
    thumbnailUrl: parsed.thumbnail_url,
  };
};

export const createUploadsResource = (client: ResourceClient) => ({
  buildUploadRequest: (params: {
    uploadType?: string;
    username?: string;
    userApiKey?: string;
  }): UploadRequest => {
    const request = client.buildRequest("/uploads.json", {
      method: "POST",
      asUser: params.username,
      userApiKey: params.userApiKey,
      accept: "application/json",
    });

    return {
      url: request.url,
      method: request.methodUpper as "POST",
      headers: request.headers,
      fields: {
        type: params.uploadType ?? DEFAULT_UPLOAD_TYPE,
      },
    };
  },

  presignUpload: (params: {
    filename: string;
    byteSize: number;
    contentType?: string;
    uploadType?: string;
    userApiKey?: string;
  }) =>
    runWithContext("Presign upload", async () => {
      const data = await client.fetchApi<any>("/uploads/generate-presigned-put", {
        method: "POST",
        body: {
          filename: params.filename,
          file_name: params.filename,
          filesize: params.byteSize,
          file_size: params.byteSize,
          content_type: params.contentType,
          upload_type: params.uploadType ?? DEFAULT_UPLOAD_TYPE,
        },
        userApiKey: params.userApiKey,
      });

      if (!data) {
        throw new Error("Empty presign response");
      }

      let parsed: z.infer<typeof RawPresignedUploadSchema>;
      try {
        parsed = parseWithSchemaOrThrow(
          RawPresignedUploadSchema,
          data,
          "Presigned upload",
          "Malformed presign response"
        );
      } catch (error) {
        const fallback = data as any;
        if (
          fallback &&
          typeof fallback.key === "string" &&
          (typeof fallback.upload_url === "string" || typeof fallback.url === "string") &&
          typeof fallback.unique_identifier === "string"
        ) {
          parsed = {
            key: fallback.key,
            url: typeof fallback.url === "string" ? fallback.url : undefined,
            upload_url:
              typeof fallback.upload_url === "string" ? fallback.upload_url : undefined,
            /* c8 ignore start */
            headers:
              fallback.headers && typeof fallback.headers === "object"
                ? fallback.headers
                : {},
            /* c8 ignore stop */
            unique_identifier: fallback.unique_identifier,
          };
        } else {
          throw error;
        }
      }

      const uploadUrl = parsed.upload_url ?? parsed.url;
      if (!uploadUrl) {
        throw new Error("Malformed presign response: upload_url missing");
      }

      return {
        method: "PUT" as const,
        uploadUrl,
        headers: normalizeHeaderValues(parsed.headers),
        key: parsed.key,
        uniqueIdentifier: parsed.unique_identifier,
      };
    }),

  batchPresignMultipartUpload: (params: {
    uniqueIdentifier: string;
    partNumbers: number[];
    uploadId?: string;
    key?: string;
    contentType?: string;
    userApiKey?: string;
  }) =>
    runWithContext("Batch presign multipart upload", async () => {
      const data = await client.fetchApi<any>(
        "/uploads/batch-presign-multipart",
        {
          method: "POST",
          body: {
            unique_identifier: params.uniqueIdentifier,
            upload_id: params.uploadId,
            key: params.key,
            part_numbers: params.partNumbers,
            content_type: params.contentType,
          },
          userApiKey: params.userApiKey,
        }
      );

      if (!data) {
        throw new Error("Empty multipart presign response");
      }

      let parsed: z.infer<typeof RawMultipartPresignSchema>;
      try {
        parsed = parseWithSchemaOrThrow(
          RawMultipartPresignSchema,
          data,
          "Multipart presign",
          "Malformed multipart presign response"
        );
      } catch (error) {
        const fallback = data as any;
        if (
          fallback &&
          typeof fallback.upload_id === "string" &&
          typeof fallback.key === "string" &&
          typeof fallback.unique_identifier === "string" &&
          Array.isArray(fallback.presigned_urls)
        ) {
          parsed = {
            upload_id: fallback.upload_id,
            key: fallback.key,
            unique_identifier: fallback.unique_identifier,
            presigned_urls: fallback.presigned_urls,
          };
        } else {
          throw error;
        }
      }

      return {
        uploadId: parsed.upload_id,
        key: parsed.key,
        uniqueIdentifier: parsed.unique_identifier,
        parts: parsed.presigned_urls.map((part) => ({
          partNumber: part.part_number,
          url: part.url,
          headers: normalizeHeaderValues(part.headers ?? {}),
        })),
      };
    }),

  completeMultipartUpload: (params: {
    uniqueIdentifier: string;
    uploadId: string;
    key: string;
    parts: Array<{ partNumber: number; etag: string }>;
    filename: string;
    uploadType?: string;
    userApiKey?: string;
  }) =>
    runWithContext("Complete multipart upload", async () => {
      const data = await client.fetchApi<{ upload?: any }>(
        "/uploads/complete-external-upload",
        {
          method: "POST",
          body: {
            upload_id: params.uploadId,
            key: params.key,
            unique_identifier: params.uniqueIdentifier,
            parts: params.parts.map((part) => ({
              part_number: part.partNumber,
              etag: part.etag,
            })),
            filename: params.filename,
            upload_type: params.uploadType ?? DEFAULT_UPLOAD_TYPE,
          },
          userApiKey: params.userApiKey,
        }
      );

      if (!data || !data.upload) {
        throw new Error("Empty upload completion response");
      }

      return { upload: mapUpload(data.upload) };
    }),

  abortMultipartUpload: (params: {
    uniqueIdentifier: string;
    uploadId: string;
    key: string;
    userApiKey?: string;
  }) =>
    runWithContext("Abort multipart upload", async () => {
      const data = await client.fetchApi<any>("/uploads/abort-multipart", {
        method: "POST",
        body: {
          unique_identifier: params.uniqueIdentifier,
          upload_id: params.uploadId,
          key: params.key,
        },
        userApiKey: params.userApiKey,
      });

      if (!data) {
        return false;
      }

      const parsed = parseWithSchema(
        RawAbortUploadSchema,
        data,
        "Abort multipart upload"
      );

      if (parsed.aborted !== undefined) {
        return parsed.aborted;
      }
      if (parsed.success !== undefined) {
        return parsed.success;
      }
      return false;
    }),
});

export type UploadsResource = ReturnType<typeof createUploadsResource>;
