import {
  type EntryProperties,
  type IOProvider,
  type Item,
  PayloadKind,
  PermanentIOError,
  type RangeReadable,
  type StreamHandle,
  TransientIOError,
} from "@flowscripter/pluggable-io-framework-api";

const CHUNK = 64 * 1024;

type JsItem = Item<PayloadKind.Js>;

/** An in-memory js provider with range reads, call counters and failure injection. */
export class MemoryProvider implements IOProvider<PayloadKind.Js> {
  readonly kind = PayloadKind.Js;
  readonly files = new Map<string, Uint8Array>();
  readonly containers = new Set<string>();
  readonly rangeReads: Array<[number, number]> = [];
  readonly deleted: string[] = [];
  opens = 0;
  chunksPulled = 0;
  cancelled = 0;
  disposed = false;
  rangeable = true;
  bounded = true;
  /** Number of upcoming opens (full or range) to fail transiently. */
  failOpens = 0;
  /** Number of upcoming streams that fail transiently after their first chunk. */
  failMidStream = 0;
  failWrite: Error | undefined;

  async [Symbol.asyncDispose](): Promise<void> {
    this.disposed = true;
  }

  async getProperties(path: string): Promise<EntryProperties> {
    if (this.containers.has(path)) {
      return { size: undefined, lastModified: undefined, isContainer: true, properties: {} };
    }
    const data = this.files.get(path);
    if (data === undefined) {
      throw new PermanentIOError(`missing ${path}`);
    }
    return {
      size: this.bounded ? data.byteLength : undefined,
      lastModified: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
      isContainer: false,
      contentType: "video/mp4",
      properties: { etag: '"abc"' },
    };
  }

  async delete(path: string): Promise<void> {
    if (!this.files.delete(path)) {
      throw new PermanentIOError(`missing ${path}`);
    }
    this.deleted.push(path);
  }

  async getReadableStream(path: string): Promise<StreamHandle<PayloadKind.Js>> {
    this.opens += 1;
    this.#maybeFailOpen();
    const data = this.#data(path);
    const handle: StreamHandle<PayloadKind.Js> = {
      kind: PayloadKind.Js,
      bounded: this.bounded,
      stream: this.#stream(data, 0, data.byteLength),
    };
    if (!this.rangeable) {
      return handle;
    }
    const ranged: StreamHandle<PayloadKind.Js> & RangeReadable<PayloadKind.Js> = {
      ...handle,
      readRange: async (start, end) => {
        this.#maybeFailOpen();
        this.rangeReads.push([start, end]);
        const bytes = this.#data(path);
        return this.#stream(bytes, start, Math.min(end, bytes.byteLength));
      },
    };
    return ranged;
  }

  async getWritableStream(path: string): Promise<StreamHandle<PayloadKind.Js>> {
    const chunks: Uint8Array[] = [];
    return {
      kind: PayloadKind.Js,
      stream: new WritableStream<JsItem>({
        write: (item) => {
          if (this.failWrite !== undefined) {
            throw this.failWrite;
          }
          chunks.push(item.payload.data);
        },
        close: () => {
          this.files.set(path, new Uint8Array(Buffer.concat(chunks)));
        },
      }),
    };
  }

  #data(path: string): Uint8Array {
    const data = this.files.get(path);
    if (data === undefined) {
      throw new PermanentIOError(`missing ${path}`);
    }
    return data;
  }

  #maybeFailOpen(): void {
    if (this.failOpens > 0) {
      this.failOpens -= 1;
      throw new TransientIOError("open failed");
    }
  }

  #stream(data: Uint8Array, start: number, end: number): ReadableStream<JsItem> {
    let position = start;
    let failAfterFirst = false;
    if (this.failMidStream > 0) {
      this.failMidStream -= 1;
      failAfterFirst = true;
    }
    let delivered = 0;
    return new ReadableStream<JsItem>(
      {
        pull: (controller) => {
          if (failAfterFirst && delivered > 0) {
            controller.error(new TransientIOError("stream dropped"));
            return;
          }
          if (position >= end) {
            controller.close();
            return;
          }
          const next = Math.min(position + CHUNK, end);
          this.chunksPulled += 1;
          delivered += 1;
          controller.enqueue({
            payload: { kind: PayloadKind.Js, data: data.slice(position, next) },
          });
          position = next;
        },
        cancel: () => {
          this.cancelled += 1;
        },
      },
      { highWaterMark: 0 },
    );
  }
}

export function bytesOf(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251);
}
