# Development

Install dependencies:

`bun install`

Test:

`bun test`

Build (produces `dist/` for Node.js and TypeScript consumers; Bun uses raw source directly):

`bun run build`

Format:

`bunx oxfmt`

Lint:

`bunx oxlint index.ts src/ tests/`

Generate HTML API documentation:

`bunx typedoc index.ts`

The unit tests run against a local gateway on a loopback port and an in-memory
provider, so they make no external network calls.

## S3 Integration Test

`tests/integration/s3.integration.test.ts` serves an S3 bucket through the
gateway using `@flowscripter/io-plugin-s3`, and exercises `HEAD`, full and
ranged `GET`, `416`, `PUT` and `DELETE`. It is skipped unless these
environment variables are set:

- `S3_TEST_ENDPOINT`: the S3-compatible endpoint
- `S3_TEST_BUCKET`: an existing bucket the credentials can read, write and delete in
- `S3_TEST_ACCESS_KEY_ID`
- `S3_TEST_SECRET_ACCESS_KEY`
- `S3_TEST_REGION`: optional, defaults to `us-east-1`

Run it against a local MinIO:

```bash
docker run -d --name minio -p 9000:9000 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  ghcr.io/coollabsio/minio:latest server /data
curl -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user minioadmin:minioadmin \
  http://127.0.0.1:9000/gateway-test
S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_BUCKET=gateway-test \
  S3_TEST_ACCESS_KEY_ID=minioadmin S3_TEST_SECRET_ACCESS_KEY=minioadmin \
  bun test tests/integration
```

The `integration-s3` workflow runs the same steps on pull requests, with no
secrets. Each run writes under a random key prefix and deletes its object.
