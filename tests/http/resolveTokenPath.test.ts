import { describe, expect, test } from "bun:test";
import { resolveTokenPath } from "../../src/http/resolveTokenPath.ts";

describe("resolveTokenPath", () => {
  test("splits token and decoded segments", () => {
    expect(resolveTokenPath("/tok/a/b%20c.mp4")).toEqual({
      kind: "ok",
      token: "tok",
      segments: ["a", "b c.mp4"],
    });
  });

  test("drops empty and dot segments", () => {
    expect(resolveTokenPath("/tok//a/./b/")).toEqual({
      kind: "ok",
      token: "tok",
      segments: ["a", "b"],
    });
  });

  test("a bare token has no segments", () => {
    expect(resolveTokenPath("/tok/")).toEqual({ kind: "ok", token: "tok", segments: [] });
  });

  test("no token is malformed", () => {
    expect(resolveTokenPath("/")).toEqual({ kind: "malformed" });
  });

  test("a bad escape sequence is malformed", () => {
    expect(resolveTokenPath("/tok/%E0%A4%A")).toEqual({ kind: "malformed" });
  });

  test("parent segments and encoded separators escape the root", () => {
    expect(resolveTokenPath("/tok/../x")).toEqual({ kind: "escape" });
    expect(resolveTokenPath("/tok/a%2F..%2Fb")).toEqual({ kind: "escape" });
    expect(resolveTokenPath("/tok/a%5Cb")).toEqual({ kind: "escape" });
    expect(resolveTokenPath("/tok/a%00")).toEqual({ kind: "escape" });
  });
});
