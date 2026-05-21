# Cryptonit — Example Leash Agent

This directory is a working example of what a developer's repo looks like
after installing Leash. It's the end state of the 3-minute quickstart in
[`summary/user-flows.md`](../../summary/user-flows.md).

## Files

| File                    | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `cryptonit-policy.md`   | Budget + upstream allowlist. Checked into git; code-reviewable. |
| `.mcp.json`             | Tells Claude Code how to launch Leash (stdio subprocess).     |
| `CLAUDE.md`             | Cryptonit's persona + tool-use guidelines for Claude Code.    |

## How a developer installs Leash into their own repo

Same three moves as the quickstart:

```bash
$ npm install -g @getleash/cli

# Copy cryptonit-policy.md and CLAUDE.md into your agent's repo, edit to taste.
$ cp examples/cryptonit/cryptonit-policy.md  ~/my-agent/
$ cp examples/cryptonit/CLAUDE.md            ~/my-agent/
$ cd ~/my-agent/

# First run — generates the owner key, prints the funding address:
$ leash apply cryptonit-policy.md

# Fund the printed hub address with USDC on Base (~30 seconds),
# then rerun:
$ leash apply cryptonit-policy.md

# `.mcp.json` has been written. Open Claude Code here.
```

Claude Code launches `leash serve cryptonit` as a stdio subprocess on its
own — no `leash serve` command to run in a separate terminal, no port to
pick, no Bearer token to manage.

## Prompts to try (golden fixtures)

These are the prompts the walking-skeleton demo must handle.
Every developer evaluating Leash should try these three in order:

1. **Happy-path price lookup** — `"What's BTC's current price?"`

   Expected: Claude calls `coinmarketcap__get_price({symbol:"BTC"})`, gets
   a 402, Leash pays 0.01 USDC transparently, data flows back. The reply
   tells the user the price and a one-line cost note ("cost 0.01 USDC;
   0.99 USDC of today's budget remains").

2. **Multi-asset + insight** — `"Which of BTC, ETH, SOL moved the most
   today?"`

   Expected: three sequential priced calls (or one batched `get_quotes`
   if the adapter exposes it), followed by a plain-English comparison.
   The tool responses carry a running `remaining_daily_usdc`.

3. **Out-of-budget case** — after running enough calls to exhaust the
   daily cap, ask: `"What's SOL's current price?"`

   Expected: the tool returns `OVER_DAILY_CAP`. Claude stops calling the
   tool and relays the `suggested_action` — something like "daily budget
   is spent; either wait until 00:00 UTC for reset or increase
   `daily_limit` in `cryptonit-policy.md` and re-apply."

## Day-two operations

- `leash status cryptonit` — balance, budget, session-key expiry, last
  call timestamp.
- `leash logs cryptonit --since=24h` — full payment log.
- `leash fund cryptonit 2.00` — top up when the budget runs low.
- `leash drain cryptonit` — pull funds back from the sub-account to the
  hub. Bypasses agent limits (the hub owner is the root signer).
- `leash revoke cryptonit` — kill the session key on-chain, immediately
  and irreversibly. Cryptonit can call this itself too, via the
  `revoke_session_key()` tool.

See [`summary/user-flows.md`](../../summary/user-flows.md) for full
transcripts, error paths, and backup / restore.
