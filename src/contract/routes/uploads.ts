import { CommonPluginErrors } from "every-plugin";
import { oc } from "every-plugin/orpc";
import {
  AbortMultipartUploadInputSchema,
  BatchPresignMultipartInputSchema,
  CompleteMultipartUploadInputSchema,
  MultipartPresignSchema,
  PrepareUploadInputSchema,
  PresignUploadInputSchema,
  PresignedUploadSchema,
  UploadRequestSchema,
  UploadSchema,
} from "../schemas/uploads";
import { z } from "every-plugin/zod";

export const uploadsRoutes = {
  prepareUpload: oc
    .route({ method: "POST", path: "/uploads/prepare" })
    .input(
      PrepareUploadInputSchema.describe(
        "Create a Discourse upload request and validate file metadata before presign"
      )
    )
    .output(
      z
        .object({ request: UploadRequestSchema })
        .describe("Normalized upload request containing key, headers, and fields to sign")
    )
    .errors(CommonPluginErrors),

  presignUpload: oc
    .route({ method: "POST", path: "/uploads/presign" })
    .input(
      PresignUploadInputSchema.describe(
        "Generate a presigned upload URL for the requested Discourse file"
      )
    )
    .output(
      PresignedUploadSchema.describe("Presigned upload details including URL, fields, and headers")
    )
    .errors(CommonPluginErrors),

  batchPresignMultipartUpload: oc
    .route({ method: "POST", path: "/uploads/multipart/presign" })
    .input(
      BatchPresignMultipartInputSchema.describe(
        "Presign multiple multipart upload parts for large file uploads"
      )
    )
    .output(
      MultipartPresignSchema.describe("Presigned part URLs and metadata for multipart upload parts")
    )
    .errors(CommonPluginErrors),

  completeMultipartUpload: oc
    .route({ method: "POST", path: "/uploads/multipart/complete" })
    .input(
      CompleteMultipartUploadInputSchema.describe(
        "Finalize a multipart upload after all parts have been successfully uploaded"
      )
    )
    .output(
      z
        .object({ upload: UploadSchema })
        .describe("Completed upload record returned after multipart completion")
    )
    .errors(CommonPluginErrors),

  abortMultipartUpload: oc
    .route({ method: "POST", path: "/uploads/multipart/abort" })
    .input(
      AbortMultipartUploadInputSchema.describe(
        "Abort a multipart upload and clean up any partially uploaded parts"
      )
    )
    .output(
      z
        .object({ aborted: z.boolean() })
        .describe("Indicates whether the multipart upload was successfully aborted")
    )
    .errors(CommonPluginErrors),
};
