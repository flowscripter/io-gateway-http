import { describe, expect, test } from "bun:test";
import { parseRange } from "../../src/http/parseRange.ts";

describe("parseRange", () => {
  test("no header is none", () => {
    expect(parseRange(null, 100)).toEqual({ kind: "none" });
  });

  test("closed range has an exclusive end", () => {
    expect(parseRange("bytes=10-19", 100)).toEqual({ kind: "range", start: 10, end: 20 });
  });

  test("end past the size is clamped", () => {
    expect(parseRange("bytes=90-500", 100)).toEqual({ kind: "range", start: 90, end: 100 });
  });

  test("open-ended range runs to the size", () => {
    expect(parseRange("bytes=40-", 100)).toEqual({ kind: "range", start: 40, end: 100 });
  });

  test("suffix range", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({ kind: "range", start: 90, end: 100 });
    expect(parseRange("bytes=-500", 100)).toEqual({ kind: "range", start: 0, end: 100 });
  });

  test("start at or past the size is unsatisfiable", () => {
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
  });

  test("multi-range, other units and malformed headers are none", () => {
    expect(parseRange("bytes=0-1,5-6", 100)).toEqual({ kind: "none" });
    expect(parseRange("items=0-1", 100)).toEqual({ kind: "none" });
    expect(parseRange("bytes=-", 100)).toEqual({ kind: "none" });
    expect(parseRange("bytes=9-3", 100)).toEqual({ kind: "none" });
  });
});
