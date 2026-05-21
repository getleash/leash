# Upstream catalog

> **Audience:** user and agent. The current list of x402-enabled APIs you can reach through Leash.

Every upstream below is **live-verified** end-to-end on Base mainnet — meaning Leash has settled real USDC against the upstream's facilitator and received a tool result back. Adapter code lives in `packages/mcp-server/src/upstreams/`.

## How to read this table

- **Namespace** — what to put in your policy file's `## Upstreams` block (`namespace:` field). Also the prefix Claude sees on every tool call (`coinmarketcap__get_price`, `exa__search`).
- **Category** — what the upstream actually does.
- **Cost / call** — published per-call price in USDC. Some upstreams price per-endpoint within the namespace; the range covers all.
- **Protocol** — `v1` or `v2`. Both are supported; only the retry header differs internally. As a user you don't pick.

## Available now (10 upstreams)

| # | Namespace | Category | Endpoint | Cost / call | Protocol |
|---|---|---|---|---|---|
| 1 | `coinmarketcap` | Crypto market data | `mcp.coinmarketcap.com/x402/mcp` (MCP) | $0.01 | v2 |
| 2 | `exa` | AI web search | `api.exa.ai/search` + `/contents` | $0.001–$0.007 | v2 |
| 3 | `neynar` | Farcaster social | `api.neynar.com/v2/farcaster/user/bulk` | $0.01 | v1 |
| 4 | `gloria` | Real-time news | `api.itsgloria.ai/news` + `/news-by-keyword` | $0.03 | v1 |
| 5 | `orac` | AI safety / prompt-injection scan | `orac-safety.orac.workers.dev/v1/{scan,audit}` | $0.05–$0.10 | v2 |
| 6 | `agoragentic` | Document tools | `x402.agoragentic.com/v1/{4 endpoints}` | $0.10 | v2 |
| 7 | `invy` | Onchain wallet lookup | `invy.bot/api/v1/wallet?address=…` | $0.05 | v2 |
| 8 | `azursafe` | Wallet / identity risk screening | `ai.azursafe.com/agent/screen-id?identifier=…` | $0.01 | v2 |
| 9 | `ottoai` | EVM tx + token explainer | `x402.ottoai.services/{token-details,contract-info-decoder}` | $0.10 | v2 |
| 10 | `donate-0000402` | Live x402 test endpoint | `donate.0000402.xyz/donate` | $0.01 | v2 |

Categories covered (10 distinct): crypto data · AI web search · Farcaster social · real-time news · AI safety · document tools · onchain wallet lookup · wallet risk screening · EVM forensics · live x402 testing.

## Using an upstream

Add it to your policy file's `## Upstreams` block:

```markdown
## Upstreams
- name: exa
  url: https://api.exa.ai/search
  namespace: exa
```

Then `leash apply` and the upstream's tools appear in Claude as `exa__search`, `exa__find_similar_links`, etc. Each tool's input schema is published via MCP `tools/list`; Claude can introspect them without you doing anything.

To **cap spending** on a single upstream tightly:

```markdown
## Upstreams
- name: orac
  url: https://orac-safety.orac.workers.dev/v1
  namespace: orac
  max_per_call: 0.05 USDC
```

The cap is enforced **on-chain** by the `SessionKeyValidator`'s per-recipient amount cap. See [`policy.md`](policy.md#max_per_call-optional).

## What "available" means

For a row to appear in the table above, **every** of these must hold:

1. Leash has a typed adapter in `packages/mcp-server/src/upstreams/<name>.ts`.
2. The upstream's `payTo` is stable (or stable-enough for the catalog model) and registered in `packages/core/src/upstream-payto.ts`.
3. **A live mainnet smoke call settled USDC and returned a tool result.** Probe-cleanness (a valid 402 challenge) is not enough; historically ~50% of probe-clean upstreams fail at settle time for legacy-facilitator or operator-side reasons. The smoke is the binding evidence.
4. The upstream's facilitator implements ERC-1271 contract-signature verification (the modern smart-wallet sig path).

Upstreams that pass probes but fail at settle time (because of a legacy facilitator, rotating payTo, or operator-side gaps) are listed in "Deferred" below.

## Deferred upstreams

Adapter files are kept in the repo for low-cost re-add when the upstream operator addresses the blocking issue. **Do not add these to your policy** — `leash apply` will accept the name but the live calls will fail.

| Upstream | Reason | Re-add trigger |
|---|---|---|
| `browserbase` | Rotates `payTo` every call. The witness validator's per-recipient amount-cap allowlist can't cover dynamic recipients. | Wildcard-cap opt-in mode ships (planned v1.1). |
| `robtex` | Legacy v1 facilitator strict-checks 65-byte EOA sigs and rejects Leash's 246-byte witness sig with `"invalid signature length"`. | Upstream operator updates their facilitator. |
| `mru-oracle` | Same legacy v1 facilitator issue. | Same. |
| `x402factory` | v1 facilitator returns `"Failed to verify payment: Bad Request"` on the witness sig. | Same. |
| `proxy-0000402`, `tempfile-0000402`, `pastebin-0000402`, `timecapsule-0000402`, `human-0000402` | Same operator as `donate-0000402`, same `payTo`, but the operator only wired x402 settlement on `/donate`. The other endpoints return 402 with an empty body on retry. | Operator wires up x402 settlement on the other endpoints. |

## Requesting a new upstream

Open an issue at [github.com/getleash/leash/issues](https://github.com/getleash/leash/issues) with:

1. The provider's name and homepage.
2. A raw `curl` against an endpoint showing the 402 challenge response (so we can confirm the protocol shape).
3. The category — does it add something new, or duplicate existing coverage?
4. The published per-call price.

Inclusion filter:

- **Permissionless** — no API-key signup or invite-only access.
- **USDC on Base** — multi-chain support is post-MVP.
- **Per-call cost $0.001 – $0.50** — the proxy is for micropayments, not bulk subscriptions.
- **Stable URL** — backed by working docs, not a temporary demo endpoint.
- **Curated category** — adds capability that isn't already covered. (We don't ship five social-feed adapters when one will do.)

## Adding your own adapter (contributors)

See [`adapter-guide.md`](adapter-guide.md) for the high-level flow, and `.claude/skills/writing-x402-adapters/SKILL.md` for the full step-by-step. Each adapter is roughly 30 LOC plus a unit test against a captured 402 challenge fixture.

## Operational notes

- **Cost-aware budgeting.** A $0.10-per-call upstream burns through the default `daily_limit: 1.00 USDC` in 10 calls. Set a tight `max_per_call` on expensive upstreams or raise your daily budget.
- **Sample-args reality check.** A few upstreams return HTTP 400 on the **tool body** when called with empty / missing args, *after* the payment settled. This means the USDC moved but the tool errored. Leash currently surfaces this as `UPSTREAM_TOOL_ERROR` (the payment is logged as `confirmed`). The agent's `CLAUDE.md` should set sensible default args for each tool it calls.
- **Upstream drift.** This catalog is a snapshot. Upstream operators can change facilitators or retire endpoints without notice. If a previously-working upstream starts failing, check the [issues page](https://github.com/getleash/leash/issues) for known drift. Persistent failures are caught by the daily smoke (post-launch) and reflected in this table within a day.
