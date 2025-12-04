import { describe, expect, it } from "vitest";
import {
  contract,
  normalizeTopicNotificationLevel,
  TopicTimerStatusSchema,
} from "../../contract";
import { TOPIC_NOTIFICATION_LEVEL_NAMES } from "../../constants";

const getInputSchema = (procedure: { ["~orpc"]: { inputSchema: any } }) =>
  procedure["~orpc"].inputSchema;

describe("contract input validation", () => {
  it("maps topic notification levels to numeric codes", () => {
    const schema = getInputSchema(contract.setTopicNotification);

    const tracking = schema.parse({
      topicId: 1,
      level: "tracking",
      username: "alice",
    });
    const watching = schema.parse({
      topicId: 1,
      level: "watching_first_post",
      username: "alice",
    });

    expect(tracking.level).toBe(2);
    expect(watching.level).toBe(4);
    expect(
      schema.safeParse({
        topicId: 1,
      level: "invalid",
      username: "alice",
    }).success
    ).toBe(false);

    expect(normalizeTopicNotificationLevel("unknown" as any)).toBe(1);
  });

  it("enforces a period when requesting top topic lists", () => {
    const schema = getInputSchema(contract.listTopicList);
    const parsed = schema.parse({ type: "top" });
    const latest = schema.parse({});
    const defaulted = schema.safeParse({ type: "top", period: undefined as any });
    const missing = schema.safeParse({ type: "top", period: null as any });

    expect(parsed.type).toBe("top");
    expect(parsed.period).toBe("monthly");
    expect(latest.type).toBe("latest");
    expect(latest.period).toBe("monthly");
    expect(defaulted.success).toBe(true);
    expect(defaulted.data?.period).toBe("monthly");
    expect(missing.success).toBe(false);
  });

  it("keeps defaults while still requiring an invite target", () => {
    const schema = getInputSchema(contract.inviteToTopic);

    const emptyTargets = schema.safeParse({ topicId: 5 });
    expect(emptyTargets.success).toBe(false);
    expect(
      emptyTargets.error?.issues.some((issue) =>
        issue.message.includes("Provide at least one username or groupName")
      )
    ).toBe(true);

    const withUsernames = schema.parse({
      topicId: 5,
      usernames: ["alice", "bob"],
    });
    expect(withUsernames.usernames).toEqual(["alice", "bob"]);
    expect(withUsernames.groupNames).toEqual([]);
  });

  it("applies enum defaults for post actions", () => {
    const schema = getInputSchema(contract.performPostAction);
    const parsed = schema.parse({ postId: 42, username: "alice" });

    expect(parsed.action).toBe("like");
    expect(parsed.postActionTypeId).toBeUndefined();
    expect(parsed.mode).toBeUndefined();

    const flagMode = schema.parse({
      postId: 42,
      username: "alice",
      mode: { mode: "flag" },
    });

    expect(flagMode.mode?.target).toBe("post");
    expect(flagMode.mode?.resolution).toBe("flag");
  });

  it("accepts all topic timer status values", () => {
    const timerSchema = getInputSchema(contract.addTopicTimer);
    const parsed = timerSchema.parse({
      topicId: 5,
      statusType: "auto_delete",
      time: "2024-03-01T00:00:00Z",
      username: "alice",
    });

    expect(parsed.statusType).toBe("auto_delete");
    expect(TopicTimerStatusSchema.parse("reminder")).toBe("reminder");
  });

  it("rejects search pagination values below 1", () => {
    const schema = getInputSchema(contract.search);

    const invalid = schema.safeParse({ query: "one", page: 0 });
    const valid = schema.parse({ query: "two", page: 2 });

    expect(invalid.success).toBe(false);
    expect(valid.page).toBe(2);
  });

  it("ensures multipart completion parts are unique", () => {
    const schema = getInputSchema(contract.completeMultipartUpload);

    const duplicate = schema.safeParse({
      uniqueIdentifier: "u1",
      uploadId: "up1",
      key: "key1",
      parts: [
        { partNumber: 1, etag: "etag-a" },
        { partNumber: 1, etag: "etag-b" },
      ],
      filename: "file.txt",
      uploadType: "composer",
    });

    expect(duplicate.success).toBe(false);
  });

  it("accepts unique multipart completion parts", () => {
    const schema = getInputSchema(contract.completeMultipartUpload);

    const parsed = schema.parse({
      uniqueIdentifier: "u2",
      uploadId: "upload-123",
      key: "key-123",
      parts: [
        { partNumber: 1, etag: "etag-a" },
        { partNumber: 2, etag: "etag-b" },
      ],
      filename: "file.txt",
      uploadType: "composer",
    });

    expect(parsed.parts).toHaveLength(2);
  });

  it("validates random multipart presign arrays with deterministic fuzzing", () => {
    const schema = getInputSchema(contract.batchPresignMultipartUpload);
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };

    for (let i = 0; i < 5; i += 1) {
      const size = 1 + Math.floor(rand() * 4);
      const partNumbers = Array.from({ length: size }, () => 1 + Math.floor(rand() * 5));
      const isUnique = new Set(partNumbers).size === partNumbers.length;
      const result = schema.safeParse({
        uniqueIdentifier: `rand-${i}`,
        partNumbers,
      });

      expect(result.success).toBe(isUnique);
    }
  });

  it("accepts varied unique multipart presign arrays", () => {
    const schema = getInputSchema(contract.batchPresignMultipartUpload);

    for (let size = 1; size <= 4; size += 1) {
      const partNumbers = Array.from({ length: size }, (_, index) => index + 1);
      const parsed = schema.parse({
        uniqueIdentifier: `upload-${size}`,
        partNumbers,
      });

      expect(parsed.partNumbers).toEqual(partNumbers);
    }
  });

  it("rejects duplicate multipart presign part numbers", () => {
    const schema = getInputSchema(contract.batchPresignMultipartUpload);

    const duplicate = schema.safeParse({
      uniqueIdentifier: "upload-1",
      partNumbers: [1, 1],
    });

    expect(duplicate.success).toBe(false);
  });

  it("accepts unique multipart presign part numbers", () => {
    const schema = getInputSchema(contract.batchPresignMultipartUpload);

    const parsed = schema.parse({
      uniqueIdentifier: "upload-2",
      partNumbers: [1, 2],
      contentType: "text/plain",
    });

    expect(parsed.partNumbers).toEqual([1, 2]);
  });

  it("maps topic notification aliases across all enum values", () => {
    const schema = getInputSchema(contract.setTopicNotification);

    for (const alias of TOPIC_NOTIFICATION_LEVEL_NAMES) {
      const parsed = schema.parse({
        topicId: 1,
        level: alias,
        username: "alice",
      });

      expect(parsed.level).toBe(normalizeTopicNotificationLevel(alias));
    }
  });
});
