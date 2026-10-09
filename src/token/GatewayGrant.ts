import {
  type IOProvider,
  isRangeReadable,
  type Item,
  type LocationTarget,
  PayloadKind,
  type RangeReadable,
  type StreamHandle,
  fromWebReadableStream,
} from "@flowscripter/pluggable-io-framework-api";
import { type RetryOptions, withRetry } from "@flowscripter/pluggable-io-framework";
import { parseRange } from "../http/parseRange.ts";
import { statusForError } from "../http/statusForError.ts";
import { createResumingReadStream } from "../stream/createResumingReadStream.ts";
import { baseName, joinKey } from "./keys.ts";
import { WriteTracker, type WriteResult } from "./WriteTracker.ts";

export type GrantScope = "read" | "read-write";

export interface GrantInit {
  readonly provider: IOProvider<PayloadKind.Js>;
  readonly target: Extract<LocationTarget, { kind: "entry" | "container" }>;
  readonly scope: GrantScope;
  readonly retry: RetryOptions;
  readonly origin: string;
  readonly token: string;
  /** Whether revoking the grant disposes the provider. */
  readonly ownsProvider: boolean;
}

type JsHandle = StreamHandle<PayloadKind.Js>;
type RangeHandle = JsHandle & RangeReadable<PayloadKind.Js>;
type JsStream = ReadableStream<Item<PayloadKind.Js>>;

function text(status: number, message: string, headers?: HeadersInit): Response {
  return new Response(message, { status, headers });
}

/**
 * Serves one root location (a container or a single entry) over HTTP,
 * restricted to a scope. Created by `HttpGateway`; revoking it makes
 * every later request a 404.
 */
export class GatewayGrant {
  readonly #init: GrantInit;
  readonly #tracker = new WriteTracker();
  readonly #rangeHandles = new Map<string, RangeHandle>();
  #revoked = false;

  constructor(init: GrantInit) {
    this.#init = init;
  }

  /** The URL of the root: the container with a trailing slash, or the single entry. */
  get url(): string {
    const { origin, token, target } = this.#init;
    const base = `${origin}/${token}/`;
    return target.kind === "entry" ? `${base}${encodeURIComponent(baseName(target.key))}` : base;
  }

  /** The URL of a path below a container root. */
  urlFor(path: string): string {
    if (this.#init.target.kind === "entry") {
      throw new TypeError("urlFor is only available for a container root");
    }
    const encoded = path
      .split("/")
      .filter((segment) => segment !== "")
      .map(encodeURIComponent)
      .join("/");
    return `${this.#init.origin}/${this.#init.token}/${encoded}`;
  }

  get revoked(): boolean {
    return this.#revoked;
  }

  /** Resolves with every write and delete result once none is in flight. */
  settled(): Promise<readonly WriteResult[]> {
    return this.#tracker.settled();
  }

  /** Stops serving requests. Writes already in flight still run to completion. */
  async revoke(): Promise<void> {
    if (this.#revoked) {
      return;
    }
    this.#revoked = true;
    this.#rangeHandles.clear();
    if (this.#init.ownsProvider) {
      await this.#tracker.settled();
      await this.#init.provider[Symbol.asyncDispose]();
    }
  }

  async handle(request: Request, segments: readonly string[]): Promise<Response> {
    const key = this.#resolveKey(segments);
    if (key === undefined) {
      return text(404, "Not Found");
    }
    const path = segments.join("/");
    switch (request.method) {
      case "GET":
      case "HEAD":
        return this.#read(request, key);
      case "PUT":
      case "POST":
        return this.#write(request, key, path);
      case "DELETE":
        return this.#delete(key, path);
      default:
        return text(405, "Method Not Allowed", { Allow: "GET, HEAD, PUT, POST, DELETE" });
    }
  }

  #resolveKey(segments: readonly string[]): string | undefined {
    const { target, provider } = this.#init;
    if (target.kind === "entry") {
      return segments.length === 1 && segments[0] === baseName(target.key) ? target.key : undefined;
    }
    if (segments.length === 0) {
      return undefined;
    }
    return segments.reduce((key, segment) => joinKey(provider, key, segment), target.key);
  }

  async #open(key: string): Promise<JsHandle> {
    return withRetry(() => this.#init.provider.getReadableStream(key), this.#init.retry);
  }

  /** Opens a handle for its range capability only, caching it when it has one. */
  async #rangeHandle(key: string): Promise<JsHandle> {
    const cached = this.#rangeHandles.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const handle = await this.#open(key);
    await (handle.stream as JsStream).cancel();
    if (isRangeReadable(handle)) {
      this.#rangeHandles.set(key, handle);
    }
    return handle;
  }

  async #read(request: Request, key: string): Promise<Response> {
    const { provider, retry } = this.#init;
    const head = request.method === "HEAD";
    const rangeHeader = request.headers.get("range");
    try {
      const properties = await withRetry(() => provider.getProperties(key), retry);
      if (properties.isContainer) {
        return text(404, "Not Found");
      }
      const size = properties.size;
      const headers = new Headers({
        "Content-Type": properties.contentType ?? "application/octet-stream",
      });
      if (properties.lastModified !== undefined) {
        headers.set("Last-Modified", properties.lastModified.toUTCString());
      }
      const etag = properties.properties.etag;
      if (typeof etag === "string") {
        headers.set("ETag", etag);
      }
      if (/\bclose\b/i.test(request.headers.get("connection") ?? "")) {
        headers.set("Connection", "close");
      }

      if (head || rangeHeader !== null) {
        const parked = await this.#rangeHandle(key);
        const rangeable = size !== undefined && parked.bounded !== false && isRangeReadable(parked);
        headers.set("Accept-Ranges", rangeable ? "bytes" : "none");
        if (head) {
          if (size !== undefined && parked.bounded !== false) {
            headers.set("Content-Length", String(size));
          }
          return new Response(null, { status: 200, headers });
        }
        if (rangeable) {
          const range = parseRange(rangeHeader, size);
          if (range.kind === "unsatisfiable") {
            headers.set("Content-Range", `bytes */${size}`);
            headers.set("Content-Length", "0");
            return new Response(null, { status: 416, headers });
          }
          if (range.kind === "range") {
            return await this.#rangeResponse(
              parked as RangeHandle,
              range.start,
              range.end,
              size,
              headers,
            );
          }
        }
      }

      return await this.#fullResponse(key, size, headers);
    } catch (error) {
      return text(statusForError(error, "read"), "Upstream read failed");
    }
  }

  async #rangeResponse(
    handle: RangeHandle,
    start: number,
    end: number,
    size: number,
    headers: Headers,
  ): Promise<Response> {
    const { retry } = this.#init;
    const open = (offset: number) => handle.readRange(offset, end);
    const initial = await withRetry(() => open(start), retry);
    headers.set("Content-Range", `bytes ${start}-${end - 1}/${size}`);
    headers.set("Content-Length", String(end - start));
    return new Response(
      createResumingReadStream({
        initial,
        startOffset: start,
        reopen: (offset) => withRetry(() => open(offset), retry),
        retry,
      }),
      { status: 206, headers },
    );
  }

  async #fullResponse(key: string, size: number | undefined, headers: Headers): Promise<Response> {
    const { retry } = this.#init;
    const handle = await this.#open(key);
    const bounded = size !== undefined && handle.bounded !== false;
    const rangeable = bounded && isRangeReadable(handle);
    headers.set("Accept-Ranges", rangeable ? "bytes" : "none");
    if (bounded) {
      headers.set("Content-Length", String(size));
    }
    if (rangeable) {
      this.#rangeHandles.set(key, handle);
    }
    return new Response(
      createResumingReadStream({
        initial: handle.stream as JsStream,
        startOffset: 0,
        reopen: rangeable
          ? (offset) => withRetry(() => handle.readRange(offset, size), retry)
          : undefined,
        retry,
      }),
      { status: 200, headers },
    );
  }

  async #write(request: Request, key: string, path: string): Promise<Response> {
    if (this.#init.scope !== "read-write") {
      return text(403, "Forbidden");
    }
    const { provider } = this.#init;
    this.#rangeHandles.delete(key);
    try {
      await this.#tracker.track("write", path, async () => {
        const handle = await provider.getWritableStream(key);
        const sink = handle.stream as WritableStream<Item<PayloadKind.Js>>;
        if (request.body === null) {
          await sink.close();
        } else {
          await fromWebReadableStream(request.body).pipeTo(sink);
        }
      });
      return new Response(null, { status: 201 });
    } catch (error) {
      return text(statusForError(error, "write"), "Upstream write failed");
    } finally {
      this.#rangeHandles.delete(key);
    }
  }

  async #delete(key: string, path: string): Promise<Response> {
    const { provider, scope } = this.#init;
    if (scope !== "read-write") {
      return text(403, "Forbidden");
    }
    if (provider.delete === undefined) {
      return text(405, "Method Not Allowed", { Allow: "GET, HEAD, PUT, POST" });
    }
    this.#rangeHandles.delete(key);
    try {
      await this.#tracker.track("delete", path, () =>
        withRetry(() => provider.delete!(key), this.#init.retry),
      );
      return new Response(null, { status: 204 });
    } catch (error) {
      return text(statusForError(error, "read"), "Upstream delete failed");
    }
  }
}
