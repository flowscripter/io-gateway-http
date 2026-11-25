# io-gateway-http notes

- Local repo created for pluggable-io-framework#20 Part 1; Nick creates the GitHub repo and pushes it himself. Do not push or add remotes.
- Bun-only: the gateway uses `Bun.serve`. Providers must be of the `js` payload kind.
- Checks: `bunx tsc --noEmit`, `bunx oxlint index.ts src/ tests/`, `bunx oxfmt --check`, `bun test`, `bun run build`.
- The published io-plugin-http and io-plugin-filesystem bundles carry no types and inline their own `PermanentIOError`/`TransientIOError` classes; tests declare the modules in `tests/fixtures/untypedPlugins.d.ts`.
- Range: a multi-range or malformed `bytes` header answers 416 (`Content-Range: bytes */<size>`); other units are ignored.
- Published io-plugin-http/s3 (not filesystem) inline their own error classes, so `instanceof` against the API classes fails (a missing S3 object gives 500, not 404). No shared workflow emits d.ts. `tests/fixtures/untypedPlugins.d.ts` stays.
- S3 integration test: `tests/integration/s3.integration.test.ts`, skipped unless `S3_TEST_*` env vars are set; CI runs it in `.github/workflows/integration-s3.yml` against a MinIO container (upstream minio images/binaries are no longer published; the community `ghcr.io/coollabsio/minio` is used).
