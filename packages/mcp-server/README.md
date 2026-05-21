# @getleash/mcp-server

The MCP proxy that fronts Leash's curated x402-enabled upstream APIs. Stdio transport, 5 own tools (`get_balance`, `get_api_budget`, `pay_for_api`, `transfer`, `revoke_session_key`), 10 live-verified upstream adapters, and a local SQLite payment log.

Part of [Leash](https://getleash.dev) — a scoped wallet for AI agents that pay for APIs.

## Install

```bash
npm install @getleash/mcp-server
```

You usually don't install this directly — install `@getleash/cli` and let `leash serve` spawn the MCP server for you via `.mcp.json`. Install `@getleash/mcp-server` on its own only if you're embedding Leash in a non-CLI toolchain (e.g., wiring it into your own MCP host).

## Use

```ts
import { serveStdio } from '@getleash/mcp-server';

const handle = await serveStdio({
  agentName: 'cryptonit',
  cwd: process.cwd(),
  // ... session-key store, RPC config
});
```

Full API + tool schemas + the upstream-tool prefix convention + error envelope: **[getleash.dev](https://getleash.dev)**.

## License

MIT © Stepan Kouba and Leash contributors.
