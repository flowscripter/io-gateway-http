import { beforeEach, describe, expect, test } from "bun:test";
import { PermanentIOError } from "@flowscripter/pluggable-io-framework-api";
import { GatewayGrant, type GrantScope } from "../../src/token/GatewayGrant.ts";
import { bytesOf, MemoryProvider } from "../fixtures/MemoryProvider.ts";

const retry = { maxRetries: 2, backoffMs: () => 0 };
const size = 300_000;
let provider: MemoryProvider;

function grant(
  scope: GrantScope = "read-write",
  target: { kind: "entry" | "container"; key: string } = { kind: "container", key: "root" },
  ownsProvider = false,
): GatewayGrant {
  return new GatewayGrant({
    provider,
    target,
    scope,
    retry,
    origin: "http://127.0.0.1:1",
    token: "tok",
    ownsProvider,
  });
}

function request(method: string, headers: Record<string, string> = {}, body?: BodyInit) {
  return new Request("http://127.0.0.1:1/tok/x", { method, headers, body });
}

async function bodyOf(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

beforeEach(() => {
  provider = new MemoryProvider();
  provider.files.set("root/movie.mp4", bytesOf(size));
  provider.files.set("root/dir/other.bin", bytesOf(10));
  provider.containers.add("root/dir");
});

describe("GatewayGrant", () => {
  test("urls", () => {
    expect(grant().url).toBe("http://127.0.0.1:1/tok/");
    expect(grant().urlFor("dir/a b.bin")).toBe("http://127.0.0.1:1/tok/dir/a%20b.bin");
    const entry = grant("read", { kind: "entry", key: "root/movie.mp4" });
    expect(entry.url).toBe("http://127.0.0.1:1/tok/movie.mp4");
    expect(() => entry.urlFor("x")).toThrow(TypeError);
  });

  test("HEAD maps properties and advertises ranges", async () => {
    const response = await grant().handle(request("HEAD"), ["movie.mp4"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(size));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("etag")).toBe('"abc"');
    expect(response.headers.get("last-modified")).toBe("Fri, 02 Jan 2026 03:04:05 GMT");
  });

  test("HEAD without range support advertises none", async () => {
    provider.rangeable = false;
    const response = await grant().handle(request("HEAD"), ["movie.mp4"]);
    expect(response.headers.get("accept-ranges")).toBe("none");
  });

  test("GET without a range streams the whole entry with a 200", async () => {
    const response = await grant().handle(request("GET"), ["movie.mp4"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(size));
    expect(await bodyOf(response)).toEqual(bytesOf(size));
  });

  test("GET with a range returns 206 with an inclusive Content-Range", async () => {
    const response = await grant().handle(request("GET", { range: "bytes=100-199" }), [
      "movie.mp4",
    ]);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 100-199/${size}`);
    expect(response.headers.get("content-length")).toBe("100");
    expect(await bodyOf(response)).toEqual(bytesOf(size).slice(100, 200));
    expect(provider.rangeReads).toEqual([[100, 200]]);
  });

  test("open-ended and suffix ranges", async () => {
    const open = await grant().handle(request("GET", { range: `bytes=${size - 5}-` }), [
      "movie.mp4",
    ]);
    expect(await bodyOf(open)).toEqual(bytesOf(size).slice(size - 5));
    const suffix = await grant().handle(request("GET", { range: "bytes=-7" }), ["movie.mp4"]);
    expect(await bodyOf(suffix)).toEqual(bytesOf(size).slice(size - 7));
  });

  test("an unsatisfiable range is a 416", async () => {
    const response = await grant().handle(request("GET", { range: `bytes=${size}-` }), [
      "movie.mp4",
    ]);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${size}`);
  });

  test("a range on an entry without range support is served whole", async () => {
    provider.rangeable = false;
    const response = await grant().handle(request("GET", { range: "bytes=10-20" }), ["movie.mp4"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("none");
    expect(await bodyOf(response)).toEqual(bytesOf(size));
  });

  test("an unbounded source is streamed with no length and no ranges", async () => {
    provider.bounded = false;
    const response = await grant().handle(request("GET", { range: "bytes=10-20" }), ["movie.mp4"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("accept-ranges")).toBe("none");
    expect(await bodyOf(response)).toEqual(bytesOf(size));
  });

  test("range handles are reused across range requests", async () => {
    const instance = grant();
    for (const range of ["bytes=0-9", "bytes=50-59", "bytes=90-99"]) {
      await bodyOf(await instance.handle(request("GET", { range }), ["movie.mp4"]));
    }
    expect(provider.opens).toBe(1);
  });

  test("the opened full stream is cancelled when only the range capability is needed", async () => {
    await grant().handle(request("HEAD"), ["movie.mp4"]);
    expect(provider.cancelled).toBe(1);
    expect(provider.chunksPulled).toBe(0);
  });

  test("Connection: close is echoed", async () => {
    const response = await grant().handle(request("HEAD", { connection: "close" }), ["movie.mp4"]);
    expect(response.headers.get("connection")).toBe("close");
    const keepAlive = await grant().handle(request("HEAD", { connection: "keep-alive" }), [
      "movie.mp4",
    ]);
    expect(keepAlive.headers.get("connection")).toBeNull();
  });

  test("transient open failures are retried", async () => {
    provider.failOpens = 2;
    const response = await grant().handle(request("GET"), ["movie.mp4"]);
    expect(await bodyOf(response)).toEqual(bytesOf(size));
  });

  test("transient failures beyond the retry budget are a 502", async () => {
    provider.failOpens = 10;
    const response = await grant().handle(request("GET"), ["movie.mp4"]);
    expect(response.status).toBe(502);
  });

  test("a mid-stream failure resumes at the first undelivered byte", async () => {
    provider.failMidStream = 1;
    const response = await grant().handle(request("GET"), ["movie.mp4"]);
    expect(await bodyOf(response)).toEqual(bytesOf(size));
    expect(provider.rangeReads).toEqual([[65536, size]]);
  });

  test("a mid-stream failure resumes a range read", async () => {
    provider.failMidStream = 1;
    const response = await grant().handle(request("GET", { range: "bytes=10-" }), ["movie.mp4"]);
    expect(await bodyOf(response)).toEqual(bytesOf(size).slice(10));
  });

  test("missing entries, containers and unknown paths are 404", async () => {
    const instance = grant();
    expect((await instance.handle(request("GET"), ["nope"])).status).toBe(404);
    expect((await instance.handle(request("GET"), ["dir"])).status).toBe(404);
    expect((await instance.handle(request("GET"), [])).status).toBe(404);
  });

  test("a nested path is joined onto the container key", async () => {
    const response = await grant().handle(request("GET"), ["dir", "other.bin"]);
    expect(await bodyOf(response)).toEqual(bytesOf(10));
  });

  test("an entry root serves only its own name", async () => {
    const entry = grant("read", { kind: "entry", key: "root/movie.mp4" });
    expect((await entry.handle(request("GET"), ["movie.mp4"])).status).toBe(200);
    expect((await entry.handle(request("GET"), ["other.mp4"])).status).toBe(404);
    expect((await entry.handle(request("GET"), ["movie.mp4", "x"])).status).toBe(404);
  });

  test("PUT streams the body to the provider and records the result", async () => {
    const instance = grant();
    const response = await instance.handle(request("PUT", {}, new Uint8Array([1, 2, 3])), [
      "dir",
      "new.bin",
    ]);
    expect(response.status).toBe(201);
    expect(provider.files.get("root/dir/new.bin")).toEqual(new Uint8Array([1, 2, 3]));
    expect(await instance.settled()).toEqual([{ operation: "write", path: "dir/new.bin" }]);
  });

  test("POST with no body writes an empty entry", async () => {
    const response = await grant().handle(request("POST"), ["empty"]);
    expect(response.status).toBe(201);
    expect(provider.files.get("root/empty")?.byteLength).toBe(0);
  });

  test("a failed write is a 502 and is recorded as an error", async () => {
    provider.failWrite = new PermanentIOError("denied");
    const instance = grant();
    const response = await instance.handle(request("PUT", {}, new Uint8Array([1])), ["x"]);
    expect(response.status).toBe(502);
    const [result] = await instance.settled();
    expect(result?.error).toBeDefined();
    expect(provider.files.has("root/x")).toBe(false);
  });

  test("DELETE removes the entry", async () => {
    const instance = grant();
    expect((await instance.handle(request("DELETE"), ["movie.mp4"])).status).toBe(204);
    expect(provider.deleted).toEqual(["root/movie.mp4"]);
    expect((await instance.handle(request("DELETE"), ["movie.mp4"])).status).toBe(404);
  });

  test("a read-only scope forbids writes and deletes", async () => {
    const instance = grant("read");
    expect((await instance.handle(request("PUT", {}, new Uint8Array([1])), ["a"])).status).toBe(
      403,
    );
    expect((await instance.handle(request("DELETE"), ["movie.mp4"])).status).toBe(403);
    expect(provider.files.has("root/a")).toBe(false);
  });

  test("a write invalidates the cached range handle", async () => {
    const instance = grant();
    await bodyOf(await instance.handle(request("GET", { range: "bytes=0-9" }), ["movie.mp4"]));
    await instance.handle(request("PUT", {}, new Uint8Array([9, 9])), ["movie.mp4"]);
    const response = await instance.handle(request("GET", { range: "bytes=0-1" }), ["movie.mp4"]);
    expect(await bodyOf(response)).toEqual(new Uint8Array([9, 9]));
    expect(provider.opens).toBe(2);
  });

  test("other methods are 405", async () => {
    expect((await grant().handle(request("PATCH"), ["movie.mp4"])).status).toBe(405);
  });

  test("revoke disposes only an owned provider", async () => {
    const borrowed = grant();
    await borrowed.revoke();
    expect(borrowed.revoked).toBe(true);
    expect(provider.disposed).toBe(false);
    const owned = grant("read", { kind: "container", key: "root" }, true);
    await owned.revoke();
    await owned.revoke();
    expect(provider.disposed).toBe(true);
  });
});
