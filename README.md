# io-gateway-http

[![version](https://img.shields.io/github/v/release/flowscripter/io-gateway-http?sort=semver)](https://github.com/flowscripter/io-gateway-http/releases)
[![build](https://img.shields.io/github/actions/workflow/status/flowscripter/io-gateway-http/release-bun-library.yml)](https://github.com/flowscripter/io-gateway-http/actions/workflows/release-bun-library.yml)
[![docs](https://img.shields.io/badge/docs-API-blue)](https://flowscripter.github.io/io-gateway-http/index.html)
[![license: MIT](https://img.shields.io/github/license/flowscripter/io-gateway-http)](https://github.com/flowscripter/io-gateway-http/blob/main/LICENSE)

> A local HTTP gateway serving
> [pluggable-io-framework](https://github.com/flowscripter/pluggable-io-framework)
> locations to tools that only speak HTTP, such as ffmpeg, ffprobe and mediainfo

## Key Features

- Serves any `js` IOProvider location, so a tool can read from and write to
  `s3:`, `http(s):`, `file:` or a composite provider without knowing about
  them.
- Listens on a loopback ephemeral port. Access is by grant: each grant has a
  random token as the first path segment (`http://127.0.0.1:<port>/<token>/<path>`),
  so relative references such as HLS playlists, image sequences and segment
  outputs resolve against the grant root with no client configuration.
- A grant is a root (a container or a single entry) plus a scope, `read` or
  `read-write`. Paths are decoded and normalised, and anything that would
  escape the root is rejected.
- Request mapping:
  - `HEAD` reports size, last modified, content type and etag. `Accept-Ranges: bytes` is only
    sent when the handle is range readable.
  - `GET` with a single range (`a-b`, `a-`, `-n`) answers `206` or `416`. A multi-range or
    malformed `bytes` range, or one starting past the end, answers `416` with
    `Content-Range: bytes */<size>`. Other units, and entries that are not range
    readable, serve the whole entry.
  - `PUT` and `POST` stream the request body to the provider, chunked or not.
  - `DELETE` calls the provider's `delete`.
  - Unbounded sources are streamed as a chunked `200` with `Accept-Ranges: none`.
- Reads are lazy with backpressure, and a client disconnect cancels the
  provider read, so a seek (dropping an open-ended range request and opening a
  new one) does not cost the data it skipped.
- Responses are never capped below the requested range, because curl-based
  clients treat a short `206` as the end of the file.
- `Connection: close` is echoed when the client sends it, and keep-alive is
  supported.
- Transient provider failures are retried by the gateway with `withRetry`,
  including resuming a read part way through, so the client does not see them.
- Every write and delete is recorded per grant. A tool's exit code says
  nothing about whether its uploads committed, so wait for `settled()` and take
  success or failure from the results.

## Usage

```typescript
import { HttpGateway } from "@flowscripter/io-gateway-http";

const gateway = HttpGateway.start();

// `registry` is a pluggable-io-framework ProviderResolver
const grant = await gateway.grantLocation(registry, "s3://bucket/media/", {
  scope: "read-write",
});

// pass grant.urlFor("input.mkv") and grant.urlFor("out/playlist.m3u8") to the tool

const results = await grant.settled();
const failed = results.filter((result) => result.error !== undefined);

await grant.revoke();
await gateway.close();
```

`grant(provider, target, options)` serves a provider the caller already owns.
`grantLocation(resolver, location, options)` resolves a `js` provider for the
location and disposes it when the grant is revoked.

## Future Work

- Serve `native` payload providers by converting their payloads to bytes. The
  gateway only serves `js` providers today.

## Further Details

- [Development](./README/development.md)
- [API Documentation](https://flowscripter.github.io/io-gateway-http/index.html)

## License

MIT © Flowscripter
