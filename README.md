# Leash

**A scoped wallet for AI agents that pay for APIs.**

Leash is an MCP proxy that sits between your AI agent (Claude Code) and x402-enabled paid APIs (like CoinMarketCap Pro). You write a markdown policy, run one command, and the agent can pay per-call in USDC on Base L2 — but only within the limits you set. On-chain session keys cap what's reachable; a local SQLite counter enforces daily/weekly/monthly budgets; one CLI command revokes everything.

> **Status: pre-launch.** On-chain x402 enforcement shipped: USDC payments flow through a witness-bearing ERC-1271 signature against the production `SessionKeyValidator`, with per-recipient amount caps installed at agent-apply time — verified end-to-end on Base mainnet. **10 live-verified x402 upstream adapters** ship in MVP: CMC, exa, neynar, gloria, orac, agoragentic, invy, azursafe, ottoai, donate-0000402 — every one settled real USDC end-to-end during the catalog smoke runs. 224 TS tests + 66 forge tests green.

---

## The story in one paragraph

John is building an AI agent called Cryptonit that correlates market data with world events. Cryptonit needs CoinMarketCap Pro, which charges $0.01/call over x402. John writes a 15-line markdown policy (`daily_limit: 1.00 USDC`, one upstream, one recipient), runs `leash apply cryptonit-policy.md`, funds the printed hub address with 5 USDC on Base (~30 seconds), reruns `leash apply`, and opens Claude Code — Leash has written `.mcp.json` for him. Cryptonit asks for a BTC price; Claude Code launches Leash as a stdio MCP subprocess; Leash calls `coinmarketcap__get_price`; CMC returns HTTP 402; Leash policy-checks, signs EIP-3009 from Cryptonit's sub-account session key, retries, returns the price. Every payment logs to SQLite. If Cryptonit goes rogue, `leash revoke cryptonit` kills the session key on-chain and the next call fails at the contract layer.

---

## Quickstart (once Phase 7 lands)

```bash
npm install -g @getleash/cli

# In your agent's repo
cp examples/cryptonit/cryptonit-policy.md ./
cp examples/cryptonit/CLAUDE.md           ./

# First run: generates the hub owner key, prints the funding address
leash apply cryptonit-policy.md

# Send ~5 USDC on Base to the printed hub address (~30s), then rerun:
leash apply cryptonit-policy.md
#   ✓ deploys hub + sub-account
#   ✓ registers session key
#   ✓ funds sub-account with the policy's initial_funding
#   ✓ writes .mcp.json at the repo root

# Open Claude Code in this directory. It launches Leash as a stdio
# subprocess; tools appear; Cryptonit pays per policy.
```

No port, no Bearer token, no separate `leash serve` terminal. Day-two: `leash status cryptonit`, `leash logs cryptonit --follow`, `leash fund cryptonit 2.00`. To stop: `leash revoke cryptonit` — atomic on-chain kill.

See [`examples/cryptonit/`](examples/cryptonit/) for a ready-to-copy starter agent — policy, `.mcp.json`, `CLAUDE.md`, and a sample prompt set.

---

## How it works

```
Claude Code (agent's repo)
    ↕ MCP over stdio (Leash launched as subprocess via .mcp.json)
Leash MCP (stdio subprocess, proxy + x402 middleware)
    ├── own tools: get_balance, get_api_budget, pay_for_api, transfer, revoke_session_key
    ├── republished upstream tools: coinmarketcap__get_price, ...
    ├── on HTTP 402: policy-check → sign EIP-3009 (session key, Kernel-wrapped EIP-712) → retry
    └── SQLite: daily/weekly counters + payment log
          ↓
Base L2: Hub (Kernel) ─CREATE2─▶ sub-account (Kernel, one per MVP) ─▶ USDC (FiatTokenV2_2)
                                   SessionKeyValidator (allowlist + expiry)
```

- **Smart account:** ZeroDev **Kernel v3.3** (ERC-7579) on ERC-4337 v0.7. One hub per user, one sub-account per agent via CREATE2. MVP is single-agent; the topology is forward-compatible with multi-agent.
- **Session keys** are ERC-7579 validators with on-chain allowlists for UserOp actions + expiry. USDC EIP-3009 payments reach Kernel via ERC-1271 with a **Kernel-wrapped EIP-712** envelope (typehash `Kernel(bytes32 hash)`, domain scoped to the sub-account).
- **Policy split:** UserOps get full on-chain enforcement (target + selector + amount + expiry); x402/EIP-3009 payments get on-chain expiry + signer validity plus local MCP pre-sign caps (fundamental limit of `isValidSignature(hash, sig)`).
- **Blast radius = sub-account balance.** Worst case on compromise is whatever the sub-account holds. The hub is untouched.

---

## Project layout

```
examples/
  cryptonit/          # Ready-to-copy starter agent (policy, .mcp.json, CLAUDE.md)
  verify-grant/       # Standalone authorization-grant verification example
packages/
  core/               # @getleash/core      — types, ABIs, policy parser, Kernel-wrapped EIP-712 builder, x402 parser
  mcp-server/         # @getleash/mcp-server — stdio MCP proxy + 5 own tools + 10 upstream adapters + SQLite
  bundler/            # @getleash/bundler   — in-process ERC-4337 v0.7 bundler
  cli/                # @getleash/cli       — apply, serve, status, logs, fund, drain, revoke, doctor, export-backup, import-backup
contracts/
  src/                # LeashFactory, SessionKeyValidator, VerifyingPaymaster
  test/               # Foundry fork tests (66/66 on Base mainnet)
  lib/                # Vendored submodules: Kernel v3.3, account-abstraction v0.7, OpenZeppelin
scripts/
  sync-abis.ts        # regenerate packages/core/src/abis/ from contracts/out/
  sync-deployments.ts # sync deployed addresses into constants.ts after a redeploy
  generate-keys.ts    # helper for generating session keys
  demo-skeleton.ts    # Phase-1 walking-skeleton fixtures driver
tests/
  fixtures/           # captured 402 challenges from each upstream's probe
```

---

## Contributing

PR-friendly. New x402 upstream adapters are the highest-leverage contribution — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues to `stepan.kouba@gmail.com` per [`SECURITY.md`](SECURITY.md).

---

## License

[MIT](LICENSE) © 2026 Stepan Kouba and Leash contributors.
