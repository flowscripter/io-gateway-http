import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { S3IOProvider } from "@flowscripter/io-plugin-s3";
import { HttpGateway } from "../../index.ts";
import type { GatewayGrant } from "../../index.ts";
import { bytesOf } from "../fixtures/MemoryProvider.ts";

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET;
const accessKeyId = process.env.S3_TEST_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_TEST_SECRET_ACCESS_KEY;
const region = process.env.S3_TEST_REGION ?? "us-east-1";
const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

const size = 300_000;

describe.skipIf(!configured)("HttpGateway serving an s3 bucket", () => {
  const prefix = `gateway-test-${crypto.randomUUID()}`;
  let gateway: HttpGateway;
  let grant: GatewayGrant;

  beforeAll(() => {
    gateway = HttpGateway.start();
    const provider = new S3IOProvider({
      bucket: bucket as string,
      region,
      endpoint,
      accessKeyId,
      secretAccessKey,
    });
    grant = gateway.grant(provider, { kind: "container", key: prefix }, { scope: "read-write" });
  });

  afterAll(async () => {
    await fetch(grant.urlFor("object.bin"), { method: "DELETE" });
    await gateway.close();
  });

  test("PUT stores an object", async () => {
    const response = await fetch(grant.urlFor("object.bin"), {
      method: "PUT",
      body: Buffer.from(bytesOf(size)),
    });
    expect(response.status).toBeLessThan(300);
    const results = await grant.settled();
    expect(results.filter((result) => result.error !== undefined)).toEqual([]);
  });

  test("HEAD reports size and advertises ranges", async () => {
    const response = await fetch(grant.urlFor("object.bin"), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(size));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).not.toBeNull();
  });

  test("GET returns the whole object", async () => {
    const response = await fetch(grant.urlFor("object.bin"));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(bytesOf(size)));
  });

  test("a ranged GET is a 206", async () => {
    const response = await fetch(grant.urlFor("object.bin"), {
      headers: { range: "bytes=1000-1999" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 1000-1999/${size}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(bytesOf(size).slice(1000, 2000)),
    );
  });

  test("an unsatisfiable, multi-range or malformed range is a 416", async () => {
    for (const range of [`bytes=${size}-`, "bytes=0-1,5-6", "bytes=oops"]) {
      const response = await fetch(grant.urlFor("object.bin"), { headers: { range } });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${size}`);
    }
  });

  test("DELETE removes the object", async () => {
    const response = await fetch(grant.urlFor("object.bin"), { method: "DELETE" });
    expect(response.status).toBeLessThan(300);
    const after = await fetch(grant.urlFor("object.bin"), { method: "HEAD" });
    expect(after.ok).toBe(false);
  });
});
