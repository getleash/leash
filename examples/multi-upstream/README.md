# multi-upstream — production test agent

A Leash agent wired for all ten of Leash's live-verified x402 upstreams, used by the maintainer to exercise Leash end-to-end against Base mainnet on a recurring schedule. Sister example to [`cryptonit/`](../cryptonit/): cryptonit is the minimal first-time UX (one upstream, one tool); `multi-upstream` is the operator's test instrument (many upstreams, cross-tool scenarios, designed to be re-run on demand).

## What's in this directory

- `multi-upstream-policy.md` — the policy file. Lists all ten upstreams so adding new test scenarios is a code-side-only change.
- `.mcp.json` — points Claude Code at `leash serve multi-upstream`. Stdio subprocess; no port.
- `CLAUDE.md` — the agent's context. Today's scope: **scenario S2 (wallet investigation)** — chains four upstreams (invy, ottoai, azursafe, exa) to profile an address. Extends to more scenarios as they ship.
- `README.md` — this file.

## How to run it

The intended usage is **not interactive**: the agent is meant to be invoked from `scripts/run-test-agent.ts` in headless mode (`claude --print --mcp-config .mcp.json …`), so it can run on a schedule without a human in the loop. But you can also open it in Claude Code interactively if you want to poke at it.

1. Set up your own operator workspace **outside** this repo (recommended `~/leash-multi-upstream/` or similar). Keep agent state — config, session keys, payment DB — out of the source tree.
2. Copy `multi-upstream-policy.md` and `.mcp.json` from this directory into your workspace.
3. Optionally copy `CLAUDE.md` if you'll open the agent in Claude Code.
4. Run `leash apply ./multi-upstream-policy.md` from your workspace. First run prints the funding address; second run (after you've sent ~$1.00 USDC + a little ETH to the hub) deploys the sub-account, installs the session-key validator with all ten upstreams allowlisted, seeds the initial funding, and writes a working `.leash/` next to your `.mcp.json`.
5. Run `leash status multi-upstream` to confirm balance + session-key expiry.
6. To smoke S2 once: `claude --print --model claude-sonnet-4-6 --strict-mcp-config --mcp-config .mcp.json --permission-mode bypassPermissions --output-format json --max-budget-usd 0.30 < /dev/null "Tell me what you can learn about wallet 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045."`

## Why two example agents?

- **cryptonit/** stays minimal — its job is "first paid call against one upstream succeeds end-to-end." If we put 10 upstreams in there, the first-time UX gets cluttered with config the new user doesn't need to understand.
- **multi-upstream/** is the operator's test agent — the thing the maintainer re-runs to catch regressions across the entire upstream catalog. Different audience, different shape.

## Cost expectations (per S2 run)

- USDC settlement: ~$0.167 (4 paid tool calls).
- Claude API (with Sonnet 4.6): ~$0.03–0.06.
- Per-run total: ~$0.20–0.25.
