# Development

Requires Node >=24.15 (uses `node:sqlite`) and pnpm.

## Commands

```
pnpm install
pnpm typecheck # tsc --noEmit over src + tests + vitest.config.ts
pnpm build     # tsc -> dist/
pnpm test      # vitest (builds dist first via global setup)
pnpm dev       # run the built server over stdio
pnpm inspect   # MCP Inspector UI against the built server
```

## Inspector check

Build first (`pnpm build`), then either:

- UI: `pnpm inspect`, connect, open Tools, confirm `ping` is listed and callable.
- CLI (no browser):
  ```
  pnpm exec mcp-inspector --cli node dist/server.js --method tools/list
  pnpm exec mcp-inspector --cli node dist/server.js --method tools/call --tool-name ping
  ```

Bin entry files (`src/server.ts`, `src/cli.ts`) must keep the `#!/usr/bin/env node` first line and LF endings (enforced by `.gitattributes` and `tests/packaging.test.ts`).
