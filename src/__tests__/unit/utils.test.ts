import { describe, expect, it } from "vitest";
import { FiberFailureCauseId, FiberFailureId } from "effect/Runtime";
import {
  effectHelpers,
  formatError,
  normalizeMeta,
  serializeError,
  unwrapError,
} from "../../utils";

describe("formatError", () => {
  it("returns the message from an Error instance", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("uses message from non-Error objects when available", () => {
    expect(formatError({ message: "plain message" })).toBe("plain message");
  });

  it("falls back to the thrown message when accessing message fails", () => {
    class ThrowingError extends Error {
      get message(): string {
        throw new Error("getter exploded");
      }
    }

    expect(formatError(new ThrowingError())).toBe("getter exploded");
  });

  it("falls back when object message getters throw", () => {
    const obj = {
      get message() {
        throw new Error("object getter exploded");
      },
    };

    expect(formatError(obj)).toBe("object getter exploded");
  });

  it("returns a placeholder when stringification fails", () => {
    const badObject = {
      toString() {
        throw new Error("no stringify");
      },
    };

    expect(formatError(badObject)).toBe("[unserializable error]");
  });

  it("stringifies primitive values", () => {
    expect(formatError(42)).toBe("42");
    expect(formatError(undefined)).toBe("undefined");
  });

  it("serializes Error instances with stack", () => {
    const error = new Error("boom");
    const serialized = serializeError(error);

    expect(serialized).toMatchObject({ message: "boom" });
    expect((serialized as any).stack).toContain("Error: boom");
  });

  it("normalizes meta objects and serializes errors", () => {
    const meta = normalizeMeta({ reason: new Error("bad"), other: 1 });

    expect(meta).toEqual(
      expect.objectContaining({
        reason: expect.objectContaining({ message: "bad" }),
        other: 1,
      })
    );
  });

  it("keeps pre-serialized errors with explicit undefined stack intact", () => {
    const serialized = { message: "already serialized", stack: undefined };
    const meta = normalizeMeta({ error: serialized });

    expect(meta?.error).toBe(serialized);
  });

  it("returns undefined when meta is absent", () => {
    expect(normalizeMeta()).toBeUndefined();
  });
});

describe("unwrapError", () => {
  it("returns original error when not a fiber failure", () => {
    const error = new Error("plain");
    expect(unwrapError(error)).toBe(error);
  });

  it("extracts failure values from fiber fail causes", () => {
    const failure = new Error("fail");
    const fiberFailure = {
      [FiberFailureId]: FiberFailureId,
      [FiberFailureCauseId]: { _tag: "Fail", failure },
    } as any;
    expect(unwrapError(fiberFailure)).toBe(failure);
  });

  it("falls back to cause.error when failure is missing", () => {
    const errorFallback = new Error("fallback");
    const fiberFailure = {
      [FiberFailureId]: FiberFailureId,
      [FiberFailureCauseId]: { _tag: "Fail", failure: undefined, error: errorFallback },
    } as any;
    expect(unwrapError(fiberFailure)).toBe(errorFallback);
  });

  it("extracts defect values from fiber die causes", () => {
    const defect = new Error("defect");
    const fiberDefect = {
      [FiberFailureId]: FiberFailureId,
      [FiberFailureCauseId]: { _tag: "Die", defect },
    } as any;
    expect(unwrapError(fiberDefect)).toBe(defect);
  });

  it("returns the original error when defect is missing", () => {
    const fiberDefect = {
      [FiberFailureId]: FiberFailureId,
      [FiberFailureCauseId]: { _tag: "Die", defect: undefined },
    } as any;
    expect(unwrapError(fiberDefect)).toBe(fiberDefect);
  });

  it("returns the original error when fail cause is empty", () => {
    const fiberFailure = {
      [FiberFailureId]: FiberFailureId,
      [FiberFailureCauseId]: { _tag: "Fail", failure: undefined, error: undefined },
    } as any;
    expect(unwrapError(fiberFailure)).toBe(fiberFailure);
  });

  it("returns the original error when cause tag is unknown", () => {
    const fiberFailure = {
      [FiberFailureId]: FiberFailureId,
      [FiberFailureCauseId]: { _tag: "Unknown" },
    } as any;
    expect(unwrapError(fiberFailure)).toBe(fiberFailure);
  });
});
