import type { Category } from "../contract";
import type { ResourceClient } from "../client";
import { runWithContext } from "../client";
import { parseWithSchemaOrThrow } from "./shared";
import { z } from "every-plugin/zod";

export const RawCategorySchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable().default(null),
  color: z.string().default(""),
  topic_count: z.number().default(0),
  post_count: z.number().default(0),
  parent_category_id: z.number().nullable().default(null),
  read_restricted: z.boolean().default(false),
});

export const mapCategory = (cat: any): Category => {
  const parsed = parseWithSchemaOrThrow(
    RawCategorySchema,
    cat,
    "Category",
    "Malformed category response"
  );
  return {
    id: parsed.id,
    name: parsed.name,
    slug: parsed.slug,
    description: parsed.description,
    color: parsed.color,
    topicCount: parsed.topic_count,
    postCount: parsed.post_count,
    parentCategoryId: parsed.parent_category_id,
    readRestricted: parsed.read_restricted,
  };
};

type CategoryShowResponse = {
  category: any;
  subcategory_list?: any[] | { categories?: any[] };
};

export const createCategoriesResource = (client: ResourceClient) => {
  const requestCategory = (idOrSlug: number | string) =>
    client.fetchApi<CategoryShowResponse>(`/c/${idOrSlug}/show.json`);

  return {
    getCategories: () =>
      runWithContext("Get categories", async () => {
        const data = await client.fetchApi<{ category_list: { categories: any[] } }>(
          "/categories.json"
        );
        if (!data) {
          return [];
        }
        const categories = data.category_list?.categories;
        if (!Array.isArray(categories)) {
          throw new Error("Malformed category response");
        }
        return categories.map((cat: unknown) => mapCategory(cat));
      }),

    getCategory: (idOrSlug: number | string) =>
      runWithContext("Get category", async () => {
        const data = await requestCategory(idOrSlug);
        if (!data) {
          throw new Error("Empty category response");
        }
        const subcategoriesSource = Array.isArray(data.subcategory_list)
          ? data.subcategory_list
          : Array.isArray((data.subcategory_list as any)?.categories)
            ? (data.subcategory_list as any).categories
            : [];
        return {
          category: mapCategory(data.category),
          subcategories: subcategoriesSource.map((cat: unknown) => mapCategory(cat)),
        };
      }),
  };
};

export type CategoriesResource = ReturnType<typeof createCategoriesResource>;
