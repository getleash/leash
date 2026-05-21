# Policy file format

> **Audience:** user. The policy file is the single contract you write to describe what an agent is allowed to do. Leash's CLI reads it, the smart contracts enforce parts of it on-chain, and the proxy enforces the rest locally.

The policy is a Markdown file. The format is deliberately tiny — every field is justified by an enforcement point, on-chain or in the proxy. There's no policy language to learn; if you can read the file, you understand what the agent can do.

## Minimal example

```markdown
# Agent Policy
name: cryptonit
chain: base
validity: 30 days
initial_funding: 1.00 USDC

## Limits
max_per_transaction: 0.10 USDC
daily_limit:         1.00 USDC
weekly_limit:        5.00 USDC
monthly_limit:      15.00 USDC

## Upstreams
- name: coinmarketcap
  url: https://mcp.coinmarketcap.com/x402/mcp
  namespace: coinmarketcap

## Recovery
drain_to_hub: enabled
```

## File structure

The file has a fixed shape:

1. **Header** — four required `key: value` lines: `name`, `chain`, `validity`, `initial_funding`.
2. **`## Limits`** — required. Four required limits: `max_per_transaction`, `daily_limit`, `weekly_limit`, `monthly_limit`. No other keys are allowed.
3. **`## Upstreams`** — required, at least one entry. Each entry is a `- name:` line followed by `url:` and `namespace:`, optionally `max_per_call:`.
4. **`## Recovery`** — required. Currently the only field is `drain_to_hub: enabled` and it must be `enabled`.
5. **`## Counterparties`** — optional. Each entry is `- name:` followed by `address:`. Defines the allowlist for the `transfer` tool.

Comment lines (starting with `#`) and blank lines are ignored anywhere.

## Header fields

### `name`

The agent's local identity. Used as the directory key under `.leash/<name>/`, the SQLite filename, the `.mcp.json` key, and the CLI argument (`leash status <name>`).

- Required.
- Must match `/^[a-z][a-z0-9_-]*$/` — lowercase, alphanumeric, hyphens or underscores; cannot start with a digit.
- Must be unique per machine. Two agents on the same laptop can't share a `name`.

### `chain`

The Base network the sub-account lives on.

- Required.
- Allowed values: `base`, `base-sepolia`.
- `base` is the mainnet path; `base-sepolia` is for testing with non-real USDC.

### `validity`

How long the session key is valid for, starting from `apply` time. Past this, every paid call fails on-chain with `SESSION_KEY_EXPIRED` and the agent has to be re-applied.

- Required.
- Format: `<positive integer> days`, e.g. `30 days`.
- Common values: `7 days` for an evaluation, `30 days` for steady-state, `365 days` for long-lived monitoring. There is no upper limit, but renewal is cheap (~270k gas + a new session key) and short validity periods narrow the blast radius if the key leaks.

### `initial_funding`

How much USDC to seed the sub-account with at `apply` time. The hub must hold at least this much; the seed transfer is part of `apply`.

- Required.
- Format: `<amount> USDC`, e.g. `1.00 USDC`. Up to 6 decimals (USDC's precision).
- Set this to roughly one-week-of-budget; you can top up mid-life with `leash fund <agent> <amount>`.

## `## Limits`

All four limit keys are **required**. The hierarchy `max_per_transaction ≤ daily ≤ weekly ≤ monthly` is enforced by the parser; out-of-order limits are a parse error.

| Field | Enforced by | Notes |
|---|---|---|
| `max_per_transaction` | On-chain (via `SessionKeyValidator`) | Per-call cap. Also the default for every upstream's `max_per_call` unless that upstream sets a tighter one. |
| `daily_limit` | Local (SQLite counter in the proxy) | UTC-day rolling. Resets at midnight UTC. |
| `weekly_limit` | Local (SQLite counter in the proxy) | UTC-week rolling, ISO week. |
| `monthly_limit` | Local (SQLite counter in the proxy) | UTC-calendar-month rolling. |

The split between on-chain (per-call) and local (windowed) is deliberate. On-chain enforcement is robust against a compromised proxy; local enforcement gives you windowed budgeting without paying gas on every check.

A call is allowed if **all four** limits would still be satisfied after it; if any fails, the proxy returns `OVER_LIMIT` and Claude relays a `Daily budget exceeded — etc.` message.

## `## Upstreams`

At least one upstream is required. Each entry has three required fields and one optional:

```markdown
- name: <catalog-name>
  url:       <full https url>
  namespace: <tool-prefix>
  max_per_call: <amt> USDC      # optional
```

### `name`

Must be a name from Leash's curated catalog — see [`upstreams.md`](upstreams.md) for the current list. An unknown name is rejected at `leash apply` time with `upstream "<name>" has no Leash adapter`.

### `url`

The upstream's x402 endpoint. Must be `https://`. Must match what the adapter expects (the catalog name pins the canonical URL; mismatched URL is a parse warning, then runtime mismatch).

### `namespace`

The MCP tool prefix. If `namespace: coinmarketcap`, the agent sees tools named `coinmarketcap__get_price`, `coinmarketcap__quote_listings`, etc. — the adapter's tool list with a `<namespace>__` prefix.

- Must match `/^[a-z][a-z0-9_-]*$/` — lowercase letters / digits / underscores / hyphens; must start with a letter.
- Conventionally matches `name`, but you can shorten (`name: coinmarketcap`, `namespace: cmc`) if you prefer.

### `max_per_call` (optional)

Per-upstream override of `max_per_transaction`. Useful when one upstream is cheap ($0.001) and another is expensive ($0.10) — set a tight cap on the expensive one without dropping the global cap.

- Format: `<amt> USDC`, must be > 0. Zero is a parser error (zero means "denied on-chain" — omit the field if you want unrestricted).
- Must be ≤ `max_per_transaction`.
- Enforced **on-chain** via the `SessionKeyValidator`'s per-recipient amount cap, installed at `apply` time.

If omitted, the upstream's effective per-call cap is `max_per_transaction`.

## `## Recovery`

Required section. Currently has exactly one field:

### `drain_to_hub`

Whether the hub owner can pull all USDC from the sub-account back to the hub, bypassing all per-call limits. This is your emergency-exit.

- Required.
- Must be exactly `enabled`. Disabling is not supported — `drain_to_hub: disabled` is a parse error. The maintainer's stance is that you should always be able to recover your own funds without the agent's cooperation; if the agent is compromised, drain is the recovery mechanism.

This is enforced on-chain by treating the hub address as an unconstrained recipient in the `SessionKeyValidator` install data. The hub-owner key signs the drain UserOp directly (not the session key); the sub-account's session key cannot perform the drain.

## `## Counterparties` (optional)

Defines the allowlist for the `transfer` tool. Each entry has a `name` and an `address`:

```markdown
## Counterparties
- name: monthly-invoice
  address: 0xabc123def456abc123def456abc123def456abc1
- name: cofounder-payout
  address: 0x0011223344556677889900112233445566778899
```

The `transfer` MCP tool is the agent's way to spend outside the API-call flow (paying an invoice, splitting revenue, tipping a contributor). The agent can only transfer to a counterparty listed here.

- `name` follows the same rules as the agent name (lowercase alphanumeric, hyphens / underscores).
- `address` must be a valid 20-byte EVM address (`0x` + 40 hex chars). Lowercase or checksummed both accepted.

If the section is missing, the `transfer` tool returns `NO_COUNTERPARTIES`. (Counterparties are an addition to the per-tx and windowed limits; transfers are still subject to those.)

## Validation rules

The parser is strict by design. Common errors:

| Error | Cause |
|---|---|
| `line N: missing required field: <name>` | A header field (`name`, `chain`, etc.) is absent. |
| `line N: invalid chain "<x>"` | `chain` is something other than `base` / `base-sepolia`. |
| `line N: invalid validity` | `validity` isn't `<positive integer> days`. |
| `line N: invalid USDC amount "<x>"` | A USDC field couldn't be parsed. Use the form `1.00 USDC` (decimals OK, up to 6 places). |
| `max_per_transaction (<a>) > daily_limit (<b>)` | Limit hierarchy violated. The same shape applies to daily > weekly and weekly > monthly. |
| `upstream "<name>" has no Leash adapter` | The catalog doesn't recognize the upstream. See [`upstreams.md`](upstreams.md). |
| `upstream url must be https` | An upstream's `url` is not `https://`. |
| `upstream namespace "<x>" must match /^[a-z][a-z0-9_-]*$/` | Invalid characters in `namespace`. |
| `max_per_call (<a>) > max_per_transaction (<b>)` | A per-upstream cap is larger than the per-tx cap. Tighten the upstream cap or relax the per-tx cap. |
| `max_per_call must be > 0` | Set the field to a positive amount; omit it entirely for "no override." |
| `missing required section "## Recovery"` | The `## Recovery` heading is absent. |
| `drain_to_hub must be "enabled"` | Drain is non-negotiable for v0.1. |
| `invalid address "<x>"` | Counterparty address isn't a valid EVM address. |
| `outside of an upstream entry` | An indented `url:` / `namespace:` line appears before any `- name:` in `## Upstreams`. |
| `unknown top-level field "<x>"` | A `key: value` line in the header isn't a recognized field. Likely a typo. |

Every error includes the offending line number where possible.

## Renewals and edits

The policy file is the source of truth. To change limits, add an upstream, or extend validity:

1. Edit `cryptonit-policy.md`.
2. Rerun `leash apply cryptonit-policy.md`.

Leash compares the on-disk policy against the installed on-chain state and applies the delta:

- New upstreams → new on-chain recipient caps installed.
- Tighter `max_per_call` → the existing entry is replaced.
- A new `validity` → a fresh session key is generated and installed; the previous key is revoked.
- Hub-owner key never changes — you're always the same identity from the hub's perspective.

Drops (removing an upstream) currently require an explicit `leash revoke` + fresh `apply`. The parser warns when the on-disk file would remove an installed cap.

## Defaults summary

Quick reference of what defaults Leash applies:

- **per-upstream `max_per_call`** = `max_per_transaction` if omitted.
- **`## Counterparties`** = empty list if omitted (transfer tool returns `NO_COUNTERPARTIES`).
- **Comments** — `#`-prefixed lines and blank lines are stripped before parsing.
- **Trailing newline** — required by some Markdown editors; the parser is tolerant.

Everything else is required and explicit, on purpose.
