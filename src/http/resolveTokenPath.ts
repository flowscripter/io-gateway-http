export type TokenPath =
  | { readonly kind: "ok"; readonly token: string; readonly segments: readonly string[] }
  | { readonly kind: "malformed" }
  | { readonly kind: "escape" };

/**
 * Splits a request pathname into its token and the decoded path segments
 * below it. Empty and `.` segments are dropped. A `..` segment, or a
 * decoded segment containing a path separator or NUL, is an `escape`.
 */
export function resolveTokenPath(pathname: string): TokenPath {
  const raw = pathname.split("/").filter((segment) => segment !== "");
  const token = raw.shift();
  if (token === undefined) {
    return { kind: "malformed" };
  }
  const segments: string[] = [];
  for (const part of raw) {
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return { kind: "malformed" };
    }
    if (segment === ".") {
      continue;
    }
    if (segment === ".." || /[/\\\0]/.test(segment)) {
      return { kind: "escape" };
    }
    segments.push(segment);
  }
  return { kind: "ok", token, segments };
}
