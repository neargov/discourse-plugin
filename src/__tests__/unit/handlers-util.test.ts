import { describe, expect, it } from "vitest";
import { registerHandlers } from "../../handlers";

describe("registerHandlers", () => {
  it("merges handler maps in order", () => {
    const router = registerHandlers({ a: 1, shared: "first" }, { b: 2 }, { shared: "last" });

    expect(router).toEqual({ a: 1, b: 2, shared: "last" });
  });
});
