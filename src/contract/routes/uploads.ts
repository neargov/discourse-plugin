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
    .input(PrepareUploadInputSchema)
    .output(z.object({ request: UploadRequestSchema }))
    .errors(CommonPluginErrors),

  presignUpload: oc
    .route({ method: "POST", path: "/uploads/presign" })
    .input(PresignUploadInputSchema)
    .output(PresignedUploadSchema)
    .errors(CommonPluginErrors),

  batchPresignMultipartUpload: oc
    .route({ method: "POST", path: "/uploads/multipart/presign" })
    .input(BatchPresignMultipartInputSchema)
    .output(MultipartPresignSchema)
    .errors(CommonPluginErrors),

  completeMultipartUpload: oc
    .route({ method: "POST", path: "/uploads/multipart/complete" })
    .input(CompleteMultipartUploadInputSchema)
    .output(z.object({ upload: UploadSchema }))
    .errors(CommonPluginErrors),

  abortMultipartUpload: oc
    .route({ method: "POST", path: "/uploads/multipart/abort" })
    .input(AbortMultipartUploadInputSchema)
    .output(z.object({ aborted: z.boolean() }))
    .errors(CommonPluginErrors),
};
