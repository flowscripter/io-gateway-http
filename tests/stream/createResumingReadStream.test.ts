import { describe, expect, test } from "bun:test";
import { PayloadKind, TransientIOError, type Item } from "@flowscripter/pluggable-io-framework-api";
import { createResumingReadStream } from "../../src/stream/createResumingReadStream.ts";

const retry = { maxRetries: 2, backoffMs: () => 0 };

function source(chunks: number[][], failure?: Error): ReadableStream<Item<PayloadKind.Js>> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        if (failure === undefined) controller.close();
        else controller.error(failure);
        return;
      }
      index += 1;
      controller.enqueue({ payload: { kind: PayloadKind.Js, data: Uint8Array.from(chunk) } });
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<number[]> {
  return Array.from(Buffer.concat(await Array.fromAsync(stream)));
}

describe("createResumingReadStream", () => {
  test("passes bytes through", async () => {
    const stream = createResumingReadStream({
      initial: source([[1, 2], [3]]),
      startOffset: 0,
      retry,
    });
    expect(await collect(stream)).toEqual([1, 2, 3]);
  });

  test("reopens at the first undelivered byte after a transient failure", async () => {
    const offsets: number[] = [];
    const stream = createResumingReadStream({
      initial: source([[1, 2]], new TransientIOError("drop")),
      startOffset: 10,
      reopen: async (offset) => {
        offsets.push(offset);
        return source([[3, 4]]);
      },
      retry,
    });
    expect(await collect(stream)).toEqual([1, 2, 3, 4]);
    expect(offsets).toEqual([12]);
  });

  test("fails once consecutive failures exceed maxRetries", async () => {
    const stream = createResumingReadStream({
      initial: source([], new TransientIOError("drop")),
      startOffset: 0,
      reopen: async () => source([], new TransientIOError("drop")),
      retry,
    });
    await expect(collect(stream)).rejects.toBeInstanceOf(TransientIOError);
  });

  test("does not retry without reopen or for permanent errors", async () => {
    const noReopen = createResumingReadStream({
      initial: source([], new TransientIOError("drop")),
      startOffset: 0,
      retry,
    });
    await expect(collect(noReopen)).rejects.toBeInstanceOf(TransientIOError);
    const permanent = createResumingReadStream({
      initial: source([], new Error("fatal")),
      startOffset: 0,
      reopen: async () => source([[1]]),
      retry,
    });
    await expect(collect(permanent)).rejects.toThrow("fatal");
  });

  test("cancel propagates to the source", async () => {
    let cancelled = false;
    const initial = new ReadableStream<Item<PayloadKind.Js>>({
      cancel() {
        cancelled = true;
      },
    });
    const stream = createResumingReadStream({ initial, startOffset: 0, retry });
    await stream.cancel();
    expect(cancelled).toBe(true);
  });
});
