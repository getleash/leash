# Writing an upstream adapter

> **Audience:** contributor. High-level guide for adding a new x402 upstream to Leash. The step-by-step walkthrough — with the gotchas, the test fixtures, the smoke gate — lives in `.claude/skills/writing-x402-adapters/SKILL.md`.

Each upstream adapter is roughly 30 lines of TypeScript plus a unit test against a captured 402 challenge. The work is mostly mechanical once you understand the shape; the hard part is verifying the upstream's facilitator actually settles USDC, which the maintainer does in a live mainnet smoke run before merge.

## When to add a new adapter

Open an issue first to confirm the upstream fits the catalog filter:

- **Permissionless** — no API-key signup or invite-only access.
- **USDC on Base** — multi-chain isn't supported yet.
- **Per-call cost $0.001 – $0.50** — Leash is for micropayments.
- **Stable URL** — backed by working docs, not a temporary demo endpoint.
- **Curated category** — adds capability not already covered.

If it qualifies, the maintainer assigns the issue and the work below begins.

## The shape

Two adapter modes, one discriminated-union type:

```typescript
type UpstreamAdapter =
  | { transport: 'mcp';       /* ... MCP-mode fields */ }
  | { transport: 'http-rest'; /* ... REST-mode fields */ };
```

- **MCP mode** — the upstream publishes its own MCP server at an HTTP URL (e.g. `https://mcp.coinmarketcap.com/x402/mcp`). Leash connects, fetches the upstream's tool list, republishes them prefixed. CoinMarketCap is the canonical example: `packages/mcp-server/src/upstreams/coinmarketcap.ts`.
- **REST mode** — the upstream is a plain HTTP API (e.g. `POST api.exa.ai/search`). Leash synthesizes MCP `inputSchema` entries from the adapter's declared tool list and translates `tools/call` into one HTTP request per tool. exa is the canonical example: `packages/mcp-server/src/upstreams/exa.ts`.

For new upstreams, REST mode covers ~90% of x402-enabled APIs in the wild.

## High-level flow

1. **Capture the 402 challenge** with a raw `curl` against the upstream's endpoint. Save the response JSON as a fixture under `tests/fixtures/upstream-probes/<name>.json`. This is the "binding evidence" — the test suite and the adapter both refer to it.

   ```bash
   curl -i -X POST https://api.exa.ai/search \
     -H 'Content-Type: application/json' \
     -d '{"query":"hello"}' > tests/fixtures/upstream-probes/exa.json
   ```

2. **Add a `payTo` entry** to `packages/core/src/upstream-payto.ts`. Read the address straight from the captured 402 challenge's `accepts[].payTo` field. Pin it; if the upstream rotates, that's a separate issue (see [`upstreams.md`](upstreams.md) → "Deferred — rotating payTo").

3. **Write the adapter** at `packages/mcp-server/src/upstreams/<name>.ts`. For REST upstreams, declare:

   ```typescript
   export const exa: UpstreamAdapter = {
     transport: 'http-rest',
     name: 'exa',
     x402Version: 2,
     baseUrl: 'https://api.exa.ai',
     tools: [
       {
         name: 'search',
         description: 'Web search powered by Exa.',
         inputSchema: { /* JSON Schema */ },
         method: 'POST',
         path: '/search',
         bodyMode: 'json',
       },
       // ... more tools
     ],
   };
   ```

4. **Register it** in `packages/mcp-server/src/upstreams/registry.ts`. One line — add the adapter to the export.

5. **Write a unit test** at `packages/mcp-server/src/upstreams/<name>.test.ts` that loads the captured 402 fixture and asserts:
   - The adapter's declared `baseUrl` matches the captured request URL.
   - The challenge's `network` and `scheme` fields are filterable to Leash's supported set.
   - The signing path produces the expected witness payload for the upstream's `payTo` + a mock authorization.

6. **Ask the maintainer to run the live mainnet smoke**. The maintainer runs `scripts/smoke-upstreams.ts` (in the operator's private workspace) with a freshly-funded sub-account, calling one tool from your adapter, settling real USDC, and verifying the result. **Probe-cleanness ≠ settle-cleanness** — historically, ~50% of probe-clean upstreams have failed the live smoke for legacy-facilitator reasons.

7. **PR review.** The self-check in [`CLAUDE.md`](../CLAUDE.md) covers the must-have checklist. Update [`upstreams.md`](upstreams.md) in the same PR with a new row (this is the docs-first rule applied; the doc and the adapter ship together).

## Common gotchas

These show up across most adapters; the skill covers each in depth.

- **Header vs body challenges (v2).** Some v2 upstreams put the challenge in the response body (e.g. exa); others put it in the `WWW-Authenticate` header. The adapter declares which.
- **v1 vs v2.** Same signing path, different retry header (`X-PAYMENT` vs `Payment-Signature`). Adapter declares `x402Version: 1` or `2`; the proxy picks the right header.
- **Path templating.** REST tools sometimes encode args into the URL path (e.g. `/wallet/{address}`). The adapter's `path: '/wallet/{address}'` + `args: { address: '...' }` produces the right URL; `bodyMode: 'none'` is implicit then.
- **Multi-chain `accepts[]`.** A v2 challenge can list multiple networks. The proxy pre-filters to Leash's supported set; the adapter doesn't need to.
- **No-auth probe is misleading.** A clean probe doesn't guarantee a clean settle. The live smoke is the binding evidence.

## The full walkthrough

For the full process — including the witness-bearing signature internals, the EIP-3009 domain quirks, and the on-chain cap install — invoke the skill:

```
@writing-x402-adapters
```

…in Claude Code, or read `.claude/skills/writing-x402-adapters/SKILL.md` directly. The skill has:

- The exact file shape per transport mode.
- The witness-payload encoding details.
- A checklist of what makes a unit test "enough."
- Debugging tips for the most common live-smoke failures.

## Once your adapter is merged

- The upstream appears in [`upstreams.md`](upstreams.md) (you'll have added the row).
- Any user with the upstream in their policy's `## Upstreams` block gets the namespaced tools on next `leash apply`.
- The maintainer adds the upstream to the daily live smoke (post-launch) — if it ever regresses (the upstream changes facilitators, retires endpoints, etc.), the smoke catches it within 24h and `upstreams.md` is updated with the deferral reason.
