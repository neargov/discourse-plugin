import { z } from "every-plugin/zod";
import { NonNegativeIntSchema, NonEmptyString, PositiveIntSchema } from "./base";

export const TagSchema = z.object({
  id: PositiveIntSchema,
  name: z.string(),
  topicCount: NonNegativeIntSchema,
  pmTopicCount: NonNegativeIntSchema,
  synonyms: z.array(z.string()),
  targetTag: z.string().nullable(),
  description: z.string().nullable(),
});

export const TagGroupSchema = z.object({
  id: PositiveIntSchema,
  name: z.string(),
  tagNames: z.array(z.string()),
  parentTagNames: z.array(z.string()),
  onePerTopic: z.boolean(),
  permissions: z.record(z.string(), z.number()),
  tags: z.array(TagSchema).optional(),
});

export const TagGroupInputSchema = z.object({
  name: NonEmptyString.min(1, "Tag group name is required"),
  tagNames: z.array(NonEmptyString).default([]),
  parentTagNames: z.array(NonEmptyString).default([]),
  onePerTopic: z.boolean().optional(),
  permissions: z.record(z.string(), z.coerce.number()).optional(),
});
