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

The tests run against a local gateway on a loopback port and an in-memory
provider, so they make no external network calls.
