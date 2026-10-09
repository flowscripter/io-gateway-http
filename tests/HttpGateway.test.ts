import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type IOProvider,
  type LocationTarget,
  PayloadKind,
  type ProviderResolver,
  toWebReadableStream,
} from "@flowscripter/pluggable-io-framework-api";
import { FilesystemIOProvider } from "@flowscripter/io-plugin-filesystem";
import { HttpIOProvider } from "@flowscripter/io-plugin-http";
import { HttpGateway } from "../index.ts";
import { bytesOf, MemoryProvider } from "./fixtures/MemoryProvider.ts";

const retry = { maxRetries: 2, backoffMs: () => 0 };
let gateway: HttpGateway;
let provider: MemoryProvider;

beforeEach(() => {
  gateway = HttpGateway.start({ retry });
  provider = new MemoryProvider();
  provider.files.set("root/movie.mp4", bytesOf(1_000_000));
});

afterEach(async () => {
  await gateway.close();
});

describe("HttpGateway", () => {
  test("serves on a loopback ephemeral port under a random token", async () => {
    const a = gateway.grant(provider, { kind: "container", key: "root" }, { scope: "read" });
    const b = gateway.grant(provider, { kind: "container", key: "root" }, { scope: "read" });
    expect(a.url).toStartWith("http://127.0.0.1:");
    expect(a.url).not.toBe(b.url);
    const response = await fetch(a.urlFor("movie.mp4"), { method: "HEAD" });
    expect(response.headers.get("content-length")).toBe("1000000");
  });

  test("unknown tokens and revoked grants are 404", async () => {
    const grant = gateway.grant(provider, { kind: "container", key: "root" }, { scope: "read" });
    expect((await fetch(`${gateway.origin}/nope/movie.mp4`)).status).toBe(404);
    await grant.revoke();
    expect((await fetch(grant.urlFor("movie.mp4"))).status).toBe(404);
  });

  test("path traversal is rejected", async () => {
    const grant = gateway.grant(provider, { kind: "container", key: "root" }, { scope: "read" });
    const url = new URL(grant.urlFor("movie.mp4"));
    const response = await fetch(`${url.origin}${url.pathname.replace("movie.mp4", "a%2F..%2Fb")}`);
    expect(response.status).toBe(403);
    expect((await fetch(`${gateway.origin}/`)).status).toBe(400);
  });

  test("a pattern target and a non-js provider cannot be granted", () => {
    expect(() =>
      gateway.grant(
        provider,
        { kind: "pattern", containerKey: "root", pattern: "*" },
        { scope: "read" },
      ),
    ).toThrow(TypeError);
    const native = { kind: PayloadKind.Native } as unknown as MemoryProvider;
    expect(() =>
      gateway.grant(native, { kind: "container", key: "root" }, { scope: "read" }),
    ).toThrow(TypeError);
  });

  test("grantLocation resolves a js provider and owns it", async () => {
    const requested: unknown[] = [];
    const resolver: ProviderResolver = {
      async createProviderForLocation(location, opts) {
        requested.push(location, opts);
        return { provider, target: { kind: "container", key: "root" } };
      },
    };
    const grant = await gateway.grantLocation(resolver, "mem://root", { scope: "read" });
    expect(requested).toEqual(["mem://root", { kind: PayloadKind.Js }]);
    expect((await fetch(grant.urlFor("movie.mp4"), { method: "HEAD" })).status).toBe(200);
    await grant.revoke();
    expect(provider.disposed).toBe(true);
  });

  test("grantLocation disposes the provider when the grant is rejected", async () => {
    const resolver: ProviderResolver = {
      async createProviderForLocation() {
        return {
          provider: provider as IOProvider,
          target: { kind: "pattern", containerKey: "root", pattern: "*" } as LocationTarget,
        };
      },
    };
    await expect(gateway.grantLocation(resolver, "mem://", { scope: "read" })).rejects.toThrow(
      TypeError,
    );
    expect(provider.disposed).toBe(true);
  });

  test("a client disconnect cancels the provider read lazily", async () => {
    provider.files.set("root/huge.bin", bytesOf(64 * 1024 * 1024));
    const grant = gateway.grant(provider, { kind: "container", key: "root" }, { scope: "read" });
    const response = await fetch(grant.urlFor("huge.bin"), {
      headers: { range: "bytes=0-" },
    });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(100);
    expect(provider.cancelled).toBe(2);
    expect(provider.chunksPulled).toBeLessThan(64);
  });

  test("Connection: close is echoed and the socket is closed", async () => {
    const grant = gateway.grant(provider, { kind: "container", key: "root" }, { scope: "read" });
    const url = new URL(grant.urlFor("movie.mp4"));
    let received = "";
    const closed = Promise.withResolvers<void>();
    const socket = await Bun.connect({
      hostname: url.hostname,
      port: Number(url.port),
      socket: {
        data(_socket, data) {
          received += data.toString();
        },
        close() {
          closed.resolve();
        },
        error() {},
      },
    });
    socket.write(`HEAD ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
    await closed.promise;
    expect(received.toLowerCase()).toContain("connection: close");
  });

  test("keep-alive serves several requests on one connection", async () => {
    const grant = gateway.grant(provider, { kind: "container", key: "root" }, { scope: "read" });
    const url = new URL(grant.urlFor("movie.mp4"));
    let received = "";
    const socket = await Bun.connect({
      hostname: url.hostname,
      port: Number(url.port),
      socket: {
        data(_socket, data) {
          received += data.toString();
        },
        error() {},
      },
    });
    const head = `HEAD ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`;
    socket.write(head);
    socket.write(head);
    await Bun.sleep(200);
    socket.end();
    expect(received.match(/HTTP\/1\.1 200/g)?.length).toBe(2);
  });

  test("ffmpeg-style chunked upload commits and is reported by settled", async () => {
    const grant = gateway.grant(
      provider,
      { kind: "container", key: "root" },
      { scope: "read-write" },
    );
    const chunks = async function* () {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    };
    const response = await fetch(grant.urlFor("out.mkv"), {
      method: "PUT",
      body: new ReadableStream({
        async start(controller) {
          for await (const chunk of chunks()) controller.enqueue(chunk);
          controller.close();
        },
      }),
      // @ts-expect-error Bun streams request bodies without a declared length
      duplex: "half",
    });
    expect(response.status).toBe(201);
    expect(await grant.settled()).toEqual([{ operation: "write", path: "out.mkv" }]);
    expect(provider.files.get("root/out.mkv")).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("close waits for in-flight writes before stopping", async () => {
    const grant = gateway.grant(
      provider,
      { kind: "container", key: "root" },
      { scope: "read-write" },
    );
    let finish!: () => void;
    const slow = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        finish = () => controller.close();
      },
    });
    const upload = fetch(grant.urlFor("slow.bin"), {
      method: "PUT",
      body: slow,
      // @ts-expect-error Bun streams request bodies without a declared length
      duplex: "half",
    });
    await Bun.sleep(50);
    let closed = false;
    const closing = gateway.close().then(() => {
      closed = true;
    });
    await Bun.sleep(50);
    expect(closed).toBe(false);
    finish();
    expect((await upload).status).toBe(201);
    await closing;
    expect(provider.files.get("root/slow.bin")).toEqual(new Uint8Array([1]));
  });
});

describe("HttpGateway close", () => {
  test("closes connections still streaming after the grace period", async () => {
    provider.files.set("root/huge.bin", bytesOf(64 * 1024 * 1024));
    const grant = gateway.grant(provider, { kind: "container", key: "root" }, { scope: "read" });
    const response = await fetch(grant.urlFor("huge.bin"));
    await response.body!.getReader().read();
    const start = Date.now();
    await gateway.close(100);
    expect(Date.now() - start).toBeLessThan(1500);
  });
});

describe("HttpGateway with io-plugin-http as the client", () => {
  const client = new HttpIOProvider({});

  test("reads, ranges and properties of a memory provider", async () => {
    const grant = gateway.grant(provider, { kind: "container", key: "root" }, { scope: "read" });
    const url = grant.urlFor("movie.mp4");
    const properties = await client.getProperties(url);
    expect(properties.size).toBe(1_000_000);
    expect(properties.contentType).toBe("video/mp4");
    const handle = await client.getReadableStream(url);
    const ranged = await (
      handle as unknown as {
        readRange(start: number, end: number): Promise<ReadableStream>;
      }
    ).readRange(10, 20);
    const bytes = Buffer.concat(
      await Array.fromAsync(
        toWebReadableStream(ranged as ReadableStream<never>) as AsyncIterable<Uint8Array>,
      ),
    );
    expect(new Uint8Array(bytes)).toEqual(bytesOf(1_000_000).slice(10, 20));
  });

  test("writes and deletes through to a memory provider", async () => {
    const grant = gateway.grant(
      provider,
      { kind: "container", key: "root" },
      { scope: "read-write" },
    );
    const url = grant.urlFor("up.bin");
    const handle = await client.getWritableStream(url);
    const writer = (handle.stream as WritableStream).getWriter();
    await writer.write({ payload: { kind: PayloadKind.Js, data: new Uint8Array([7, 8]) } });
    await writer.close();
    expect(provider.files.get("root/up.bin")).toEqual(new Uint8Array([7, 8]));
    await client.delete!(url);
    expect(provider.files.has("root/up.bin")).toBe(false);
  });

  test("serves the local filesystem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gateway-"));
    try {
      await writeFile(join(dir, "a.txt"), "hello gateway");
      const fsProvider = new FilesystemIOProvider();
      const grant = gateway.grant(
        fsProvider,
        { kind: "container", key: dir },
        { scope: "read-write" },
      );
      const url = grant.urlFor("a.txt");
      expect((await client.getProperties(url)).size).toBe(13);
      const ranged = await fetch(url, { headers: { range: "bytes=6-12" } });
      expect(await ranged.text()).toBe("gateway");
      expect(ranged.status).toBe(206);
      await fetch(grant.urlFor("b.txt"), { method: "PUT", body: "written" });
      expect(await readFile(join(dir, "b.txt"), "utf8")).toBe("written");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
