import { PermanentIOError, TransientIOError } from "@flowscripter/pluggable-io-framework-api";

/**
 * The HTTP status for a provider failure. A permanent failure reading or
 * deleting is reported as not found; a permanent write failure and a
 * transient failure that outlived its retries are an upstream error.
 */
export function statusForError(error: unknown, operation: "read" | "write"): number {
  if (error instanceof PermanentIOError) {
    return operation === "read" ? 404 : 502;
  }
  if (error instanceof TransientIOError) {
    return 502;
  }
  return 500;
}
