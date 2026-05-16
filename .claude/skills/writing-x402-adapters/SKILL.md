---
name: writing-x402-adapters
description: How to add a new curated x402 upstream adapter to Leash. Use when authoring a new file under packages/mcp-server/src/upstreams/, adding a payTo to packages/core/src/upstream-payto.ts, or debugging an adapter that probes cleanly but fails to settle. Walks through the discriminated-union adapter shape (MCP vs HTTP REST), the per-recipient on-chain cap that MUST be installed at `leash apply` time, how to capture a probe fixture, and the live-mainnet smoke gate that makes the adapter shippable.
---

# Writing x402 upstream adapters

Leash is a **curated** proxy, not a generic x402 firehose. Each supported upstream ships as a small adapter (~30 LOC of TypeScript) that declares its protocol quirks. The proxy reads those quirks and drives `@getleash/core`'s x402 parser, EIP-3009 signer, and Kernel-wrapped 1271 builder correctly for that specific upstream.

This document is what you read **before** authoring a new adapter, and what you re-read when an adapter probes cleanly but fails to settle.

## When the curated model bites

PoC-B (the first live integration against CoinMarketCap, 2026-04-14) surfaced **three** real incompatibilities in a single upstream:

1. Challenge location: header vs body.
2. EIP-3009 payload shape: `payload.{authorization, signature}` vs `payload.{signature, transferAuthorization}`.
3. Network identifier: CAIP-2 `eip155:8453` vs shorthand `base`.

A "works with any x402 URL" claim would have to handle all combinations of these plus future ones the spec hasn't grown yet. So instead: each upstream gets a typed adapter, and adding a new one is **explicit work**, not config drift.

Inclusion filter (also in `CONTRIBUTING.md`):
- Permissionless (no API-key signup before first call).
- USDC on Base.
- $0.001–$0.50 per call.
- Stable URL backed by docs or a verified live endpoint.

If the candidate doesn't pass the filter, open an issue and we'll discuss before writing code.

## The adapter shape

All adapters implement the discriminated union `UpstreamAdapter = McpUpstreamAdapter | HttpRestUpstreamAdapter` from `packages/mcp-server/src/upstreams/types.ts`. Read that file before this section — it's the source of truth.

### Common fields (BaseUpstreamAdapter)

| Field | Values | Notes |
|---|---|---|
| `name` | `string` | Used in the policy markdown's `## Upstreams` list. Must equal the `UPSTREAM_PAYTO` key. |
| `x402Version` | `1` \| `2` | Detected by probing — read `x402Version` from the upstream's 402 response body. |
| `challengeLocation` | `'body'` \| `'header'` | Body = `{ x402Version, accepts: [...] }` in JSON response. Header = `payment-required` or `www-authenticate` carries the base64-encoded JSON. |
| `usdcDomainSource` | `'challenge-extra'` \| `'hardcoded'` | Use `challenge-extra` if the upstream populates `accepts[].extra.{name, version}`; that's the safest because the upstream is declaring exactly what the facilitator expects. Use `hardcoded` only when the upstream omits `extra`. |

### MCP-mode (`transport: 'mcp'`)

Used when the upstream ships a real MCP server (currently only CoinMarketCap). The proxy opens a session at the upstream's URL, calls `tools/list` at startup, and republishes every tool under the adapter's namespace prefix.

```typescript
export const coinmarketcapAdapter: McpUpstreamAdapter = {
  name: 'coinmarketcap',
  transport: 'mcp',
  x402Version: 2,
  challengeLocation: 'header',
  usdcDomainSource: 'challenge-extra',
};
```

That's the entire adapter. No tool list — the upstream supplies it.

### HTTP-REST mode (`transport: 'http-rest'`)

Used when the upstream is a plain REST API. The adapter **declares** the tool list Leash synthesizes for the agent; each tool call becomes one HTTP request. Most of the 10 live MVP adapters are REST.

```typescript
export const exaAdapter: HttpRestUpstreamAdapter = {
  name: 'exa',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'header',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://api.exa.ai',
  tools: [
    {
      name: 'search',
      description: 'Neural + keyword web search via Exa. ... $0.007 / call.',
      inputSchema: { type: 'object', properties: { ... }, required: ['query'] },
      method: 'POST',
      path: '/search',
    },
    // ...
  ],
};
```

REST-tool fields (full reference in `types.ts::RestToolSpec`):

| Field | Notes |
|---|---|
| `name` | Tool name; proxy prefixes with the adapter's namespace (e.g. `exa__search`). |
| `description` | Surfaced to the agent. Be concrete about cost — include `$X.XX / call`. |
| `inputSchema` | JSON Schema, passed verbatim to the agent. Mirror the upstream's docs. |
| `method` | `'GET'` or `'POST'`. |
| `path` | Appended to `baseUrl`. May contain `{param}` placeholders substituted from args. |
| `bodyMode` | `'json'` (default; POST body), `'query'` (query string), or `'none'`. |
| `headers` | Extra headers — used to force x402 mode on dual-mode endpoints. |

## Steps to add a new adapter

### 1. Probe the upstream — capture a fixture

```bash
curl -i -X <METHOD> https://<upstream>/<path> \
  -H 'Content-Type: application/json' \
  -d '<minimum-valid-body>' > /tmp/probe-raw.txt
```

What you're looking for in the response:

- HTTP status **402** (not 401, not 200). 200 means it's not an x402 endpoint.
- A `payTo` address (in the body or the base64-decoded header).
- `x402Version: 1` or `2`.
- `network: "base"` or equivalent. Reject Solana-only, Polygon-only, multi-chain-without-Base.
- The USDC asset address: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (FiatTokenV2_2). Anything else is not real USDC.

Save the response — both headers and body — as `tests/fixtures/upstream-probes/<name>.json`. Use one of the existing fixtures as the format template (see `neynar.json` for a header-challenge example, `gloria.json` for a body-challenge example).

### 2. Add the payTo entry

In `packages/core/src/upstream-payto.ts`, add an entry to `UPSTREAM_PAYTO`:

```typescript
'<name>': {
  base: '<payTo address from the probe>',
},
```

Use the **exact case** from the 402 response (don't lowercase it — checksum is the contract). The comment block above the entry should record: probe date, endpoint, cost per call, x402 version.

### 3. Author the adapter

Create `packages/mcp-server/src/upstreams/<name>.ts`. Use:
- `coinmarketcap.ts` as the template for MCP-mode.
- `exa.ts` as the template for REST with header challenges.
- `gloria.ts` as the template for REST with body challenges and v1.

Match the file's comment block style: 4–6 line context block at the top (what the upstream does, probe date, payTo, version, gotchas).

### 4. Register the adapter

In `packages/mcp-server/src/upstreams/registry.ts`, add the import and the `ADAPTERS` entry. Keep the registry alphabetical inside its semantic grouping (the comments distinguish active vs. dropped — don't add new ones to the dropped block).

### 5. Unit test

Add a test next to the adapter:

```typescript
// packages/mcp-server/src/upstreams/<name>.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { parseX402Challenge } from '@getleash/core';
import { <name>Adapter } from './<name>.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../../../tests/fixtures/upstream-probes/<name>.json'), 'utf8'),
);

describe('<name> adapter', () => {
  it('parses the live probe', () => {
    const parsed = parseX402Challenge({
      status: fixture.status,
      headers: fixture.rawHeaders,
      body: fixture.rawBody,
      adapter: <name>Adapter,
    });
    expect(parsed.payTo).toBe(<name>Adapter.name === 'coinmarketcap' ? '0x271189c8...' : '0x...');
    expect(parsed.amount).toBe(...n);
  });
});
```

The point of the test is to **lock in the probe shape**. If the upstream silently changes their challenge format, the test fails first and you investigate before the live smoke loses real USDC.

### 6. Live mainnet smoke (maintainer)

You don't run this — the maintainer does, with real USDC on Base mainnet. The smoke harness is in the maintainer's private workspace; it deploys a fresh sub-account, installs the SessionKeyValidator with the new recipient, seeds the sub-account, runs one tool call, settles real USDC, and verifies the upstream returns a tool result.

**Probe-cleanness ≠ settle-cleanness.** During the Phase D catalog smoke, 9 of 19 probed-clean upstreams failed at settle time for documented reasons (legacy facilitators, rotating payTo, incomplete operator-side x402 wiring). Your adapter passes the gate only when the live smoke logs the upstream returning data, not just a 402.

## Common gotchas

### Header vs body challenges

Some upstreams put the 402 challenge in the response body as JSON; others encode it as base64 in a `payment-required` or `www-authenticate` header. Probe both — `curl -i` shows headers. If `Content-Length: 0` on a 402 response, the challenge is in a header.

Get this wrong and the proxy's `parseX402Challenge` will silently return `undefined` and the retry never fires.

### v1 vs v2 payload shape

v1 facilitators (from before the smart-wallet-sig path landed in the reference impl) often:
- Strict-check 65-byte EOA sigs and reject Leash's 246-byte witness sig with `invalid signature length`.
- Return `Failed to verify payment: Bad Request` with no detail.

If you see either pattern, the upstream's facilitator is legacy — there's nothing the adapter can do. Document the upstream as deferred (with the trigger to re-add: operator updates their facilitator) and move on. Don't ship a "best effort" adapter that prompts users to expect failure.

### USDC domain version

USDC's EIP-712 domain on Base has `version: "2"`, **not `"2.2"`**, even though the deployed contract is FiatTokenV2_2. If `usdcDomainSource: 'hardcoded'` is in your adapter, double-check the constant in `packages/core/src/constants.ts::USDC_DOMAIN_VERSION` — it's `"2"`.

### Rotating payTo

Some providers (encountered with Browserbase during D.5) rotate the `payTo` address on every call. The witness validator's per-recipient cap is installed at `leash apply` time and is fixed thereafter — it cannot pre-cover a dynamic recipient. **Don't try to work around this in the adapter.** It's an architectural decision deferred to a future wildcard-cap mode. If you discover a candidate rotates payTo, drop it for MVP and open an issue referencing task #22.

### Path-substituted params

If a REST tool's `path` contains `{param}` placeholders, those args are removed from the body/query string before the request is sent. The agent never knows the difference — but if you forget to declare the placeholder, the proxy throws at request time with a clear error. Check `proxy/rest-client.ts` for the substitution logic.

### `Accept: application/x402+json`

A handful of upstreams have dual-mode endpoints — they return 200 with JSON if you ask for `application/json`, and 402 with a challenge if you ask for `application/x402+json`. If the probe returns 200, try the explicit `Accept` header before concluding it's not an x402 endpoint. Force the header in the adapter via the tool spec's `headers` field.

## When to read what

- **`packages/mcp-server/src/upstreams/types.ts`** — the source of truth for the adapter shape. Read it first.
- **`packages/mcp-server/src/upstreams/{coinmarketcap, exa, gloria}.ts`** — templates for the three main combinations (MCP, REST-header-v2, REST-body-v1).
- **`packages/core/src/x402.ts`** — challenge parser. The function `parseX402Challenge` is what your adapter's quirks feed.
- **`packages/core/src/upstream-payto.ts`** — the registry. Comments record probe dates and the dropped-upstream rationale; mirror the style.
- **`packages/mcp-server/src/proxy/paid-caller.ts`** — the transport-agnostic call path. Read this if a failure is happening between "challenge parsed" and "retry sent."
- **`packages/mcp-server/src/proxy/rest-client.ts`** — the REST synthesizer. Read this if the adapter's tool calls produce wrong-shaped HTTP requests.
- **`tests/fixtures/upstream-probes/`** — your golden inputs. Pattern-match a new probe against an existing one of similar shape.

## Checklist before opening the PR

- [ ] Probe fixture committed at `tests/fixtures/upstream-probes/<name>.json`.
- [ ] `UPSTREAM_PAYTO[<name>]` entry added with date + endpoint + cost in the comment.
- [ ] Adapter file written, registered in `registry.ts`.
- [ ] Unit test green: `npm test --workspace @getleash/mcp-server`.
- [ ] Inclusion filter passed: permissionless, USDC-on-Base, $0.001–$0.50, stable URL.
- [ ] PR description includes the raw 402 response (paste the probe fixture) and any unusual quirks.
- [ ] You did not run the live mainnet smoke; that's the maintainer's gate.
