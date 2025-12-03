import { describe, expect, it } from "vitest";
import {
  contract,
  normalizeTopicNotificationLevel,
  TopicTimerStatusSchema,
} from "../../contract";

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
});
