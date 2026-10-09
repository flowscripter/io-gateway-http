import { describe, expect, test } from "bun:test";
import { PermanentIOError, TransientIOError } from "@flowscripter/pluggable-io-framework-api";
import { statusForError } from "../../src/http/statusForError.ts";

describe("statusForError", () => {
  test("permanent failure", () => {
    expect(statusForError(new PermanentIOError("x"), "read")).toBe(404);
    expect(statusForError(new PermanentIOError("x"), "write")).toBe(502);
  });

  test("transient failure is an upstream error", () => {
    expect(statusForError(new TransientIOError("x"), "read")).toBe(502);
    expect(statusForError(new TransientIOError("x"), "write")).toBe(502);
  });

  test("anything else is a server error", () => {
    expect(statusForError(new Error("x"), "read")).toBe(500);
  });
});
