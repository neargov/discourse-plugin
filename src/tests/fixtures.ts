type Overrides = Partial<Record<string, unknown>>;

type SearchFixture = {
  posts: any[];
  topics: any[];
  users: any[];
  categories: any[];
  grouped_search_result?: {
    post_ids?: number[];
    more_full_page_results?: string | null;
  };
} & Record<string, unknown>;

type SearchOverrides = Partial<SearchFixture>;

export const validPostPayload = (
  overrides: Overrides = {}
): Record<string, unknown> => ({
  id: 5,
  topic_id: 10,
  post_number: 1,
  username: "alice",
  name: "Alice",
  avatar_template: "/avatar.png",
  raw: "raw content",
  cooked: "<p>Cooked</p>",
  created_at: "2024-01-01",
  updated_at: "2024-01-02",
  reply_count: 0,
  like_count: 1,
  reply_to_post_number: null,
  can_edit: true,
  version: 2,
  ...overrides,
});

export const validTopicPayload = (
  overrides: Overrides = {}
): Record<string, unknown> => ({
  id: 10,
  title: "Topic Title",
  slug: "topic-title",
  category_id: 3,
  created_at: "2024-01-01",
  last_posted_at: "2024-01-02",
  posts_count: 2,
  reply_count: 1,
  like_count: 5,
  views: 100,
  pinned: false,
  closed: false,
  archived: false,
  visible: true,
  ...overrides,
});

export const validCategoryPayload = (
  overrides: Overrides = {}
): Record<string, unknown> => ({
  id: 10,
  name: "General",
  slug: "general",
  description: null,
  color: "fff",
  topic_count: 1,
  post_count: 1,
  parent_category_id: null,
  read_restricted: false,
  ...overrides,
});

export const validTagPayload = (
  overrides: Overrides = {}
): Record<string, unknown> => ({
  id: 1,
  name: "tag1",
  topic_count: 0,
  pm_topic_count: 0,
  synonyms: [],
  target_tag: null,
  description: null,
  ...overrides,
});

export const validTagGroupPayload = (
  overrides: Overrides = {}
): Record<string, unknown> => ({
  id: 1,
  name: "Group",
  tag_names: ["tag1"],
  parent_tag_names: [],
  one_per_topic: false,
  permissions: { everyone: 1 },
  tags: [validTagPayload()],
  ...overrides,
});

export const validUserPayload = (
  overrides: Overrides = {}
): Record<string, unknown> => ({
  id: 1,
  username: "alice",
  name: "Alice",
  avatar_template: "/avatar.png",
  title: "Title",
  trust_level: 2,
  moderator: false,
  admin: false,
  ...overrides,
});

export const validAdminUserPayload = (
  overrides: Overrides = {}
): Record<string, unknown> => ({
  ...validUserPayload(),
  email: "alice@example.com",
  active: true,
  last_seen_at: "2024-01-01T00:00:00Z",
  staged: false,
  ...overrides,
});

export const validDirectoryItemPayload = (
  overrides: Overrides = {}
): Record<string, unknown> => ({
  user: validUserPayload(),
  likes_received: 5,
  likes_given: 2,
  topics_entered: 3,
  posts_read: 10,
  days_visited: 7,
  topic_count: 1,
  post_count: 2,
  ...overrides,
});

export const validRevisionPayload = (
  overrides: Overrides = {}
): Record<string, unknown> => ({
  number: 1,
  post_id: 5,
  user_id: 2,
  username: "moderator",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
  raw: "Original content",
  cooked: "<p>Original content</p>",
  changes: { raw: ["Old", "New"] },
  ...overrides,
});

export const baseSearchResponse = (
  overrides: SearchOverrides = {}
): SearchFixture => ({
  posts: [
    validPostPayload({
      id: 1,
      topic_id: 2,
      post_number: 1,
      topic: { title: "Topic Title" },
      blurb: "snippet",
    }),
  ],
  topics: [
    validTopicPayload({
      id: 2,
      category_id: 10,
      posts_count: 1,
      reply_count: 0,
      like_count: 1,
      views: 10,
    }),
  ],
  users: [validUserPayload()],
  categories: [validCategoryPayload()],
  grouped_search_result: {
    post_ids: [1],
    more_full_page_results: "more",
  },
  ...overrides,
});

export const validSearchResponse = (
  overrides: SearchOverrides = {}
): SearchFixture => {
  const base = baseSearchResponse();

  return {
    ...base,
    ...overrides,
    posts: (overrides.posts as any) ?? base.posts.map((p) => ({ ...p })),
    topics: (overrides.topics as any) ?? base.topics.map((t) => ({ ...t })),
    users: (overrides.users as any) ?? base.users.map((u) => ({ ...u })),
    categories: (overrides.categories as any) ?? base.categories.map((c) => ({ ...c })),
    grouped_search_result:
      (overrides.grouped_search_result as any) ?? { ...base.grouped_search_result },
  };
};

type UploadOverrides = Partial<{
  uploadType: string | undefined;
  username: string | undefined;
  userApiKey: string | undefined;
  filename: string;
  byteSize: number;
  contentType: string | undefined;
  uniqueIdentifier: string;
  uploadId: string;
  key: string;
  parts: Array<{ partNumber: number; etag: string }>;
}>;

export const uploadPayload = (overrides: UploadOverrides = {}) => ({
  uploadType: "composer" as string | undefined,
  username: "alice" as string | undefined,
  userApiKey: "user-api-key" as string | undefined,
  filename: "file.png",
  byteSize: 10,
  contentType: "image/png" as string | undefined,
  uniqueIdentifier: "abc",
  uploadId: "upload-1",
  key: "uploads/key",
  parts: [{ partNumber: 1, etag: "etag-1" }],
  ...overrides,
});
