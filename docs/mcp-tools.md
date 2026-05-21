# MCP tools

> **Audience:** agent (Claude Code in an agent's repo) and contributor. The tools Leash publishes over MCP — the five Leash-owned tools plus the namespaced upstream tools.

When Claude Code launches `leash serve <agent>`, the MCP subprocess publishes two sets of tools over stdio:

1. **Own tools** — five tools defined by Leash itself.
2. **Upstream tools** — every tool from every upstream in the policy's `## Upstreams` block, namespace-prefixed.

Every tool returns either a success result (whatever shape the tool defines) or a structured error envelope. The error envelope is the same across all tools; see [Error envelope](#error-envelope) below.

## Tool naming

- **Leash's own tools** are unprefixed: `get_balance`, `get_api_budget`, `pay_for_api`, `transfer`, `revoke_session_key`.
- **Upstream tools** are prefixed with the namespace from the policy file, separated by **two underscores**: `<namespace>__<toolname>`.

Example: with the policy `namespace: coinmarketcap` and `namespace: exa`, the tool list looks like:

```
get_balance
get_api_budget
pay_for_api
transfer
revoke_session_key
coinmarketcap__get_price
coinmarketcap__quote_listings
coinmarketcap__quote_historical
exa__search
exa__find_similar_links
exa__get_contents
```

The double-underscore is unambiguous (single underscores are common in tool names) and re-parses cleanly back to `(namespace, toolname)`. The agent never needs to know this — the namespace prefix is just a part of the tool name.

## Own tools

### `get_balance`

Read-only. Returns the USDC balance of the sub-account (or any address you pass).

**Input:**

```json
{
  "account": "0x..."   // optional; defaults to the agent's sub-account
}
```

**Output:** `{ "address": "0x...", "balance": "0.92 USDC" }`

**Common use:** the agent calls this before asking the user "may I pay for X?" to know whether the call will fit in the sub's current balance.

### `get_api_budget`

Read-only. Returns the policy's limits, current spend in each window, and remaining budget.

**Input:** none.

**Output:**

```json
{
  "max_per_transaction": "0.10 USDC",
  "daily_limit":         "1.00 USDC",
  "weekly_limit":        "5.00 USDC",
  "monthly_limit":       "15.00 USDC",
  "spend_today":         "0.08 USDC",
  "spend_this_week":     "0.12 USDC",
  "spend_this_month":    "0.34 USDC",
  "remaining_today":     "0.92 USDC",
  "remaining_this_week": "4.88 USDC",
  "remaining_this_month": "14.66 USDC"
}
```

**Common use:** before initiating a non-trivial paid workflow, the agent calls this to confirm there's room.

### `pay_for_api`

Explicit one-shot paid API call. The "manual" path — the 402 retry loop bypassed.

Most calls go through the **automatic** path: the agent calls `<namespace>__<toolname>`, the upstream returns 402, Leash signs and retries transparently. `pay_for_api` exists for cases where the agent needs to:

- Trigger a paid call against an upstream that **doesn't** publish MCP tools (a REST-only API).
- Pass arbitrary JSON body / query args the auto-published tool schemas don't cover.
- Make an idempotent retry of a failed paid call.

**Input:**

```json
{
  "upstream": "exa",                 // namespace from your policy
  "tool":     "search",              // unprefixed tool name
  "args":     { "query": "..." }     // tool-specific args
}
```

**Output:** whatever the upstream returns — the same shape the auto-published tool would have returned.

**Common use:** rare in day-to-day agent flow. Mostly for power users.

### `transfer`

Send USDC from the sub-account to a counterparty (one of the addresses listed in the policy's `## Counterparties` block).

**Input:**

```json
{
  "counterparty": "monthly-invoice",   // name from the policy
  "amount":       "0.50 USDC"
}
```

**Output:** `{ "tx_hash": "0x...", "amount": "0.50 USDC", "to": "0x..." }`

The transfer is signed by the session key (not the hub owner key) and routed through `EntryPoint.handleOps`. The counterparty must appear in the policy's `## Counterparties`; otherwise the tool returns `UNKNOWN_COUNTERPARTY`. Per-tx and windowed limits still apply.

**Common use:** programmatic invoice payment, splitting agent revenue with a co-author, etc.

### `revoke_session_key`

Kill the agent's session key on-chain. The next paid call (any tool) fails at the contract layer.

**Input:** none.

**Output:** `{ "tx_hash": "0x...", "revoked_at": "2026-05-20T18:42:09Z" }`

**Note:** this is the **agent-initiated** revoke. The same effect is achievable from the CLI via `leash revoke <agent>`. The agent calling its own revoke is unusual — it's meant for the agent to use if it detects internal corruption (e.g., a prompt-injection success).

**Common use:** rare. The CLI revoke is the typical operator path.

## Upstream tools

Every upstream's tool list is automatically republished with the namespace prefix. For an MCP-mode upstream (like CoinMarketCap), Leash forwards the tool's `inputSchema` directly. For a REST-mode upstream (like exa), Leash synthesizes MCP `inputSchema` entries from the adapter's declared tool list.

When Claude calls one of these tools:

1. Leash issues the HTTP request the adapter describes (path + method + args encoding).
2. The upstream returns 402 with an x402 challenge (or 200 if it accepted the call without payment — rare; see the docs note on this in [`upstreams.md`](upstreams.md)).
3. Leash parses the challenge, policy-checks against your limits, signs an EIP-3009 `TransferWithAuthorization` from the session key, retries the upstream with the signed payment header.
4. The upstream's facilitator verifies the signature, settles USDC on-chain, returns the result.
5. Leash logs the payment to SQLite and forwards the result to Claude.

From the agent's perspective, this is one tool call — the 402 dance is invisible. You see either a result or a structured error.

## Error envelope

Every tool failure returns a structured envelope. The shape is uniform across own tools and upstream tools:

```json
{
  "isError": true,
  "content": [
    { "type": "text", "text": "Leash: <human-readable error string>" }
  ],
  "structuredContent": {
    "code":             "OVER_DAILY_LIMIT",
    "category":         "limits",
    "details":          { ... code-specific ... },
    "suggested_action": "leash fund cryptonit 1.00  or  wait until UTC midnight"
  }
}
```

Field meanings:

- **`code`** — the canonical error tag. Stable across Leash versions; safe to switch on programmatically.
- **`category`** — one of `config`, `auth`, `limits`, `funds`, `upstream`, `network`. Drives Claude's retry behavior: `network` and `upstream` errors are sometimes retriable; `limits`, `funds`, `auth`, `config` errors should NOT be retried (the agent should report to the user).
- **`details`** — structured data per code (the offending value, the relevant address, the amount, etc.).
- **`suggested_action`** — one-line, action-oriented hint Claude can relay to the user. Always non-empty.
- **`content[0].text`** — the same information in prose. This is what Claude sees as the tool result and typically relays.

## Error codes

The canonical list. Match against `structuredContent.code`.

| Code | Category | When |
|---|---|---|
| `CONFIG_MISSING` | config | The agent isn't registered on this machine, or the `.leash/<name>/` state is malformed. |
| `SESSION_KEY_EXPIRED` | auth | Past the policy's `validity` window. Rerun `leash apply` to renew. |
| `SESSION_KEY_REVOKED` | auth | `leash revoke` ran, or the agent revoked itself. Rerun `leash apply` to bring it back. |
| `OVER_PER_TX_LIMIT` | limits | The call exceeds `max_per_transaction` (or the per-upstream `max_per_call`). |
| `OVER_DAILY_LIMIT` | limits | Today's spend + this call > `daily_limit`. Resets at UTC midnight. |
| `OVER_WEEKLY_LIMIT` | limits | Same shape, weekly window. |
| `OVER_MONTHLY_LIMIT` | limits | Same shape, monthly window. |
| `INSUFFICIENT_FUNDS` | funds | Sub-account doesn't have enough USDC for this call. Run `leash fund`. |
| `UNKNOWN_COUNTERPARTY` | config | `transfer` was called with a counterparty not in the policy. |
| `UPSTREAM_402_PARSE_FAILED` | upstream | The upstream returned 402 but the challenge shape isn't parseable. Likely an upstream-side change. |
| `UPSTREAM_TOOL_ERROR` | upstream | The payment settled but the upstream tool returned 4xx/5xx (e.g., missing required args). |
| `FACILITATOR_REJECTED` | upstream | The upstream's facilitator rejected Leash's signed retry. Often a legacy v1 facilitator that doesn't support contract sigs — see [`upstreams.md`](upstreams.md). |
| `RPC_ERROR` | network | Base RPC failure (timeout, rate-limit, transient unavailability). Often retriable. |
| `BUNDLER_ERROR` | network | The in-process bundler's UserOp submission failed. Often retriable. |

The full list (with `details`-field schemas per code) lives in `summary/errors.md` in the planning workspace and in the code at `packages/mcp-server/src/errors.ts`. New codes follow the same shape — add an entry here in the same PR per the docs-first workflow.

## Tool retries — what Claude should do

The category drives retry behavior:

- **`auth`, `config`, `limits`, `funds`** — do **not** retry. Surface the `suggested_action` to the user and stop.
- **`network`** — retry with backoff (1s, 5s, 15s, give up). Usually transient.
- **`upstream`** — single retry if `code` is `UPSTREAM_TOOL_ERROR` and you can adjust args. Otherwise surface and stop.

The agent's `CLAUDE.md` (shipped with `examples/cryptonit/CLAUDE.md`) encodes these defaults so Claude doesn't loop on a `daily_limit` error or fire a thousand requests against a flaky RPC.
