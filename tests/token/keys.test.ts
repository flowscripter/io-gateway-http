import { describe, expect, test } from "bun:test";
import { baseName, joinKey } from "../../src/token/keys.ts";
import { MemoryProvider } from "../fixtures/MemoryProvider.ts";

describe("keys", () => {
  test("joinKey defaults to a slash join", () => {
    const provider = new MemoryProvider();
    expect(joinKey(provider, "a/", "b")).toBe("a/b");
    expect(joinKey(provider, "", "b")).toBe("b");
    expect(joinKey(provider, "a", "")).toBe("a");
  });

  test("joinKey strips all trailing slashes from the container key", () => {
    const provider = new MemoryProvider();
    expect(joinKey(provider, "a///", "b")).toBe("a/b");
    expect(joinKey(provider, "///", "b")).toBe("/b");
  });

  test("joinKey completes quickly on a long run of slashes", () => {
    const provider = new MemoryProvider();
    const container = `${"/".repeat(200_000)}x${"/".repeat(200_000)}`;
    const start = performance.now();
    expect(joinKey(provider, container, "b")).toBe(`${"/".repeat(200_000)}x/b`);
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("baseName completes quickly on long separator runs", () => {
    const key = `a${"/\\".repeat(100_000)}`;
    const start = performance.now();
    expect(baseName(key)).toBe("a");
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("joinKey uses the provider rule when present", () => {
    const provider = Object.assign(new MemoryProvider(), {
      joinKey: (container: string, name: string) => `${container}|${name}`,
    });
    expect(joinKey(provider, "a", "b")).toBe("a|b");
  });

  test("baseName takes the last segment", () => {
    expect(baseName("a/b/c.mp4")).toBe("c.mp4");
    expect(baseName("a\\b\\c.mp4")).toBe("c.mp4");
    expect(baseName("c.mp4")).toBe("c.mp4");
  });
});
