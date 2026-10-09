import {
  type Item,
  PayloadKind,
  toWebReadableStream,
  TransientIOError,
} from "@flowscripter/pluggable-io-framework-api";
import { backoff, type RetryOptions } from "@flowscripter/pluggable-io-framework";

export interface ResumingReadOptions {
  readonly initial: ReadableStream<Item<PayloadKind.Js>>;
  /** Byte offset in the entry at which `initial` starts. */
  readonly startOffset: number;
  /** Opens a stream from the given byte offset, or omit to disable resuming. */
  readonly reopen?: (offset: number) => Promise<ReadableStream<Item<PayloadKind.Js>>>;
  readonly retry: RetryOptions;
}

/**
 * A pull-based byte stream over a provider read. When the provider fails
 * transiently part way through, the read is reopened at the first byte not
 * yet delivered, so the HTTP client never sees the failure. Consecutive
 * failures are counted against `retry.maxRetries` and reset once data arrives.
 * Cancelling the returned stream cancels the provider stream.
 */
export function createResumingReadStream(options: ResumingReadOptions): ReadableStream<Uint8Array> {
  const { reopen, retry } = options;
  let offset = options.startOffset;
  let failures = 0;
  let reader = toWebReadableStream(options.initial).getReader();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          failures = 0;
          offset += value.byteLength;
          controller.enqueue(value);
          return;
        } catch (error) {
          if (reopen === undefined || !(error instanceof TransientIOError)) {
            throw error;
          }
          failures += 1;
          if (failures > retry.maxRetries) {
            throw error;
          }
          await backoff(retry, failures);
          reader = toWebReadableStream(await reopen(offset)).getReader();
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
