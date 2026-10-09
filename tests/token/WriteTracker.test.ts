import { describe, expect, test } from "bun:test";
import { WriteTracker } from "../../src/token/WriteTracker.ts";

describe("WriteTracker", () => {
  test("settled with nothing in flight resolves immediately", async () => {
    expect(await new WriteTracker().settled()).toEqual([]);
  });

  test("records successes and failures", async () => {
    const tracker = new WriteTracker();
    await tracker.track("write", "a", async () => {});
    const failure = new Error("boom");
    await expect(
      tracker.track("delete", "b", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await tracker.settled()).toEqual([
      { operation: "write", path: "a" },
      { operation: "delete", path: "b", error: failure },
    ]);
  });

  test("settled waits for in-flight operations", async () => {
    const tracker = new WriteTracker();
    let release!: () => void;
    const pending = tracker.track(
      "write",
      "a",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    expect(tracker.inFlight).toBe(1);
    let settled = false;
    const waiting = tracker.settled().then((results) => {
      settled = true;
      return results;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await pending;
    expect(await waiting).toEqual([{ operation: "write", path: "a" }]);
    expect(tracker.inFlight).toBe(0);
  });
});
