import { z } from "every-plugin/zod";
import { NonNegativeIntSchema, PositiveIntSchema } from "./base";

export const CategorySchema = z.object({
  id: PositiveIntSchema,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  color: z.string(),
  topicCount: NonNegativeIntSchema,
  postCount: NonNegativeIntSchema,
  parentCategoryId: PositiveIntSchema.nullable(),
  readRestricted: z.boolean(),
});
