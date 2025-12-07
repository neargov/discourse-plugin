import { z } from "every-plugin/zod";
import type { Tag, TagGroup } from "../contract";
import type { ResourceClient } from "../client";
import { runWithContext } from "../client";
import { normalizePermissions, parseWithSchemaOrThrow } from "./shared";

export const RawTagSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  topic_count: z.number().default(0),
  pm_topic_count: z.number().default(0),
  count: z.number().optional(),
  pm_only: z.boolean().optional(),
  synonyms: z.array(z.string()).default([]),
  target_tag: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
});

export const RawTagGroupSchema = z.object({
  id: z.number(),
  name: z.string(),
  tag_names: z.array(z.string()).default([]),
  parent_tag_names: z.array(z.string()).default([]),
  one_per_topic: z.boolean().default(false),
  permissions: z.record(z.string(), z.coerce.number()).default({}),
  tags: z.array(RawTagSchema).default([]),
});

export const mapTag = (tag: any): Tag => {
  const parsed = parseWithSchemaOrThrow(
    RawTagSchema,
    tag,
    "Tag",
    "Malformed tag response"
  );
  const id = typeof parsed.id === "number" ? parsed.id : hashStringToNumber(parsed.id);
  const topicCount = parsed.topic_count ?? parsed.count ?? 0;

  return {
    id,
    name: parsed.name,
    topicCount,
    pmTopicCount: parsed.pm_topic_count ?? 0,
    synonyms: parsed.synonyms,
    targetTag: parsed.target_tag,
    description: parsed.description,
  };
};

const hashStringToNumber = (str: string): number => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash) || 1;
};

export const mapTagGroup = (group: any): TagGroup => {
  const parsed = parseWithSchemaOrThrow(
    RawTagGroupSchema,
    group && typeof group === "object"
      ? { ...group, permissions: normalizePermissions((group as any).permissions) }
      : group,
    "Tag group",
    "Malformed tag group response"
  );
  const tags = parsed.tags.map((tag: unknown) => mapTag(tag));
  const permissions = normalizePermissions(parsed.permissions);

  return {
    id: parsed.id,
    name: parsed.name,
    tagNames: parsed.tag_names,
    parentTagNames: parsed.parent_tag_names,
    onePerTopic: parsed.one_per_topic,
    permissions,
    tags,
  };
};

export const createTagsResource = (client: ResourceClient) => ({
  getTags: () =>
    runWithContext("Get tags", async () => {
      const data = await client.fetchApi<{ tags?: any[] }>("/tags.json");
      if (!data) {
        return [];
      }
      if (!Array.isArray(data.tags)) {
        throw new Error("Malformed tags response");
      }
      return data.tags.map((tag: unknown) => mapTag(tag));
    }),

  getTag: (name: string) =>
    runWithContext("Get tag", async () => {
      const data = await client.fetchApi<{ tag?: any }>(`/tags/${encodeURIComponent(name)}.json`);
      if (!data || !data.tag) {
        throw new Error("Empty tag response");
      }
      return mapTag(data.tag);
    }),

  getTagGroups: () =>
    runWithContext("Get tag groups", async () => {
      const data = await client.fetchApi<{ tag_groups?: any[] }>("/tag_groups.json");
      if (!data) {
        return [];
      }
      if (!Array.isArray(data.tag_groups)) {
        throw new Error("Malformed tag groups response");
      }
      return data.tag_groups.map((group: unknown) => mapTagGroup(group));
    }),

  getTagGroup: (tagGroupId: number) =>
    runWithContext("Get tag group", async () => {
      const data = await client.fetchApi<{ tag_group?: any }>(
        `/tag_groups/${tagGroupId}.json`
      );
      if (!data || !data.tag_group) {
        throw new Error("Empty tag group response");
      }
      return mapTagGroup(data.tag_group);
    }),

  createTagGroup: (params: {
    name: string;
    tagNames?: string[];
    parentTagNames?: string[];
    onePerTopic?: boolean;
    permissions?: Record<string, unknown>;
  }) =>
    runWithContext("Create tag group", async () => {
      const permissions = normalizePermissions(params.permissions ?? {});
      const hasPermissions = Object.keys(permissions).length > 0;

      const data = await client.fetchApi<{ tag_group: any }>("/tag_groups.json", {
        method: "POST",
        body: {
          tag_group: {
            name: params.name,
            tag_names: params.tagNames ?? [],
            parent_tag_names: params.parentTagNames ?? [],
            one_per_topic: params.onePerTopic,
            permissions: hasPermissions ? permissions : undefined,
          },
        },
      });

      if (!data || !data.tag_group) {
        throw new Error("Empty tag group response");
      }

      return mapTagGroup(data.tag_group);
    }),

  updateTagGroup: (params: {
    tagGroupId: number;
    name?: string;
    tagNames?: string[];
    parentTagNames?: string[];
    onePerTopic?: boolean;
    permissions?: Record<string, unknown>;
  }) =>
    runWithContext("Update tag group", async () => {
      const permissions = normalizePermissions(params.permissions);
      const hasPermissions = Object.keys(permissions).length > 0;

      const data = await client.fetchApi<{ tag_group: any }>(
        `/tag_groups/${params.tagGroupId}.json`,
        {
          method: "PUT",
          body: {
            tag_group: {
              name: params.name,
              tag_names: params.tagNames,
              parent_tag_names: params.parentTagNames,
              one_per_topic: params.onePerTopic,
              permissions: hasPermissions ? permissions : undefined,
            },
          },
        }
      );

      if (!data || !data.tag_group) {
        throw new Error("Empty tag group response");
      }

      return mapTagGroup(data.tag_group);
    }),
});

export type TagsResource = ReturnType<typeof createTagsResource>;
