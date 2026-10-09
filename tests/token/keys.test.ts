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
