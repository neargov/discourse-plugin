import { CommonPluginErrors } from "every-plugin";
import { oc } from "every-plugin/orpc";
import { z } from "every-plugin/zod";
import {
  CategorySchema,
  NonEmptyString,
  PositiveIntSchema,
  SiteBasicInfoSchema,
  SiteInfoSchema,
  TagGroupInputSchema,
  TagGroupSchema,
  TagSchema,
} from "../schemas";

export const metaRoutes = {
  ping: oc
    .route({ method: "GET", path: "/ping" })
    .output(
      z.object({
        status: z.enum(["healthy", "degraded", "unhealthy"]),
        checks: z.object({
          discourse: z.boolean(),
          cache: z.boolean(),
          cleanup: z.boolean(),
        }),
        timestamp: z.string().datetime(),
      }).describe("Lightweight health response for the Discourse plugin")
    )
    .errors(CommonPluginErrors),

  getCategories: oc
    .route({ method: "GET", path: "/categories" })
    .output(
      z
        .object({ categories: z.array(CategorySchema) })
        .describe("List of Discourse categories with basic details")
    )
    .errors(CommonPluginErrors),

  getCategory: oc
    .route({ method: "POST", path: "/categories/get" })
    .input(
      z.object({
        idOrSlug: z.union([PositiveIntSchema, NonEmptyString]),
      }).describe("Category id or slug to retrieve details and subcategories")
    )
    .output(
      z.object({
        category: CategorySchema,
        subcategories: z.array(CategorySchema),
      }).describe("Category details and its immediate subcategories")
    )
    .errors(CommonPluginErrors),

  getTags: oc
    .route({ method: "GET", path: "/tags" })
    .output(
      z
        .object({ tags: z.array(TagSchema) })
        .describe("All available tags from the Discourse instance")
    )
    .errors(CommonPluginErrors),

  getTag: oc
    .route({ method: "POST", path: "/tags/get" })
    .input(
      z.object({ name: NonEmptyString }).describe("Tag name to fetch details for")
    )
    .output(z.object({ tag: TagSchema }).describe("Details for the requested tag"))
    .errors(CommonPluginErrors),

  getTagGroups: oc
    .route({ method: "GET", path: "/tag-groups" })
    .output(
      z
        .object({ tagGroups: z.array(TagGroupSchema) })
        .describe("All tag groups configured in Discourse")
    )
    .errors(CommonPluginErrors),

  getTagGroup: oc
    .route({ method: "POST", path: "/tag-groups/get" })
    .input(
      z.object({ tagGroupId: PositiveIntSchema }).describe("Tag group id to fetch")
    )
    .output(z.object({ tagGroup: TagGroupSchema }).describe("Details for the requested tag group"))
    .errors(CommonPluginErrors),

  createTagGroup: oc
    .route({ method: "POST", path: "/tag-groups/create" })
    .input(TagGroupInputSchema.describe("Tag group settings to create"))
    .output(
      z.object({ tagGroup: TagGroupSchema }).describe("Created tag group and its configuration")
    )
    .errors(CommonPluginErrors),

  updateTagGroup: oc
    .route({ method: "POST", path: "/tag-groups/update" })
    .input(
      z.object({
        tagGroupId: PositiveIntSchema,
        name: NonEmptyString.optional(),
        tagNames: z.array(NonEmptyString).optional(),
        parentTagNames: z.array(NonEmptyString).optional(),
        onePerTopic: z.boolean().optional(),
        permissions: z.record(z.string(), z.coerce.number()).optional(),
      }).describe("Fields to update for an existing tag group")
    )
    .output(
      z.object({ tagGroup: TagGroupSchema }).describe("Updated tag group and its configuration")
    )
    .errors(CommonPluginErrors),

  getSiteInfo: oc
    .route({ method: "GET", path: "/site" })
    .output(SiteInfoSchema.describe("Full Discourse site info including categories and settings"))
    .errors(CommonPluginErrors),

  getSiteBasicInfo: oc
    .route({ method: "GET", path: "/site/basic-info" })
    .output(SiteBasicInfoSchema.describe("Basic Discourse site metadata"))
    .errors(CommonPluginErrors),
};
