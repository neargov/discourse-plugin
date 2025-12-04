export const TRANSIENT_STATUSES = new Set([408, 425, 429, 499, 502, 503, 504]);
export const DEFAULT_BODY_SNIPPET_LENGTH = 200;

export const POST_ACTIONS = [
  "like",
  "unlike",
  "flag",
  "flag_off_topic",
  "flag_inappropriate",
  "flag_spam",
  "notify_user",
  "notify_moderators",
  "custom",
] as const;

export const POST_ACTION_TYPE_MAP: Record<string, number> = {
  bookmark: 1,
  like: 2,
  unlike: 2,
  flag: 3,
  flag_off_topic: 3,
  flag_inappropriate: 4,
  flag_spam: 5,
  notify_user: 6,
  notify_moderators: 7,
  informative: 8,
  vote: 9,
};

export const DEFAULT_UPLOAD_TYPE = "composer" as const;

export const TOPIC_NOTIFICATION_LEVEL_NAMES = [
  "muted",
  "regular",
  "tracking",
  "watching",
  "watching_first_post",
] as const;

export const TOPIC_NOTIFICATION_LEVEL_MAP: Record<
  (typeof TOPIC_NOTIFICATION_LEVEL_NAMES)[number],
  number
> = {
  muted: 0,
  regular: 1,
  tracking: 2,
  watching: 3,
  watching_first_post: 4,
};

export const TOPIC_TIMER_STATUSES = [
  "open",
  "close",
  "delete",
  "publish",
  "auto_close",
  "auto_delete",
  "reminder",
] as const;

export type RetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
};

// Alias to avoid breaking any downstream imports if they existed.
export type RetryPolicyDefaults = RetryPolicy;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 0,
  baseDelayMs: 250,
  maxDelayMs: 5000,
  jitterRatio: 0.2,
};
