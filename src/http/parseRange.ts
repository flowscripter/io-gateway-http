export type RangeRequest =
  | { readonly kind: "none" }
  | { readonly kind: "range"; readonly start: number; readonly end: number }
  | { readonly kind: "unsatisfiable" };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * Parses a `Range` header against an entry of `size` bytes into a byte range
 * with an exclusive `end`. A missing header or a malformed or multi-range
 * header is `none` (the whole entry is served); a range starting at or past
 * `size` is `unsatisfiable`.
 */
export function parseRange(header: string | null, size: number): RangeRequest {
  if (header === null) {
    return { kind: "none" };
  }
  const match = SINGLE_RANGE.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) {
    return { kind: "none" };
  }
  const [, first, last] = match as unknown as [string, string, string];
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "range", start: Math.max(0, size - suffix), end: size };
  }
  const start = Number(first);
  if (start >= size) {
    return { kind: "unsatisfiable" };
  }
  if (last === "") {
    return { kind: "range", start, end: size };
  }
  const inclusiveEnd = Number(last);
  if (inclusiveEnd < start) {
    return { kind: "none" };
  }
  return { kind: "range", start, end: Math.min(inclusiveEnd + 1, size) };
}
