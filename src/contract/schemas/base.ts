import { z } from "every-plugin/zod";
import { DEFAULT_UPLOAD_TYPE } from "../../constants";

export const TrimmedString = z.string().trim();
export const NonEmptyString = TrimmedString.min(1);
export const RequiredUsernameSchema = TrimmedString.min(1, "Discourse username is required");
export const OptionalUsernameSchema = RequiredUsernameSchema.optional();
export const RequiredUserApiKeySchema = TrimmedString.min(1);
export const OptionalUserApiKeySchema = RequiredUserApiKeySchema.optional();
export const PositiveIntSchema = z.number().int().positive();
export const NonNegativeIntSchema = z.number().int().nonnegative();
export const TimestampSchema = z.string().datetime();
export const UploadTypeSchema = TrimmedString.min(1).default(DEFAULT_UPLOAD_TYPE);
export const SlugSchema = TrimmedString.min(1);
export const PageSchema = NonNegativeIntSchema.default(0);
export const SuccessSchema = z.object({ success: z.boolean() });

export const UniquePositiveIntArraySchema = z
  .array(PositiveIntSchema)
  .nonempty()
  .superRefine((values, ctx) => {
    const seen = new Set<number>();
    for (const value of values) {
      if (seen.has(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Values must be unique",
        });
        return;
      }
      seen.add(value);
    }
  });
