# Leash

> **Audience:** anyone evaluating Leash for the first time.

**A scoped wallet for AI agents that pay for APIs.**

Leash is an MCP proxy that sits between your AI agent (Claude Code, today) and x402-enabled paid APIs (CoinMarketCap, exa, neynar, …). You write a 15-line Markdown policy, run one command, and the agent can pay per-call in USDC on Base L2 — but only within the limits you set. On-chain session keys cap what's reachable; a local SQLite counter enforces daily/weekly/monthly budgets; one CLI command revokes everything.

## The three-minute pitch

John is building an AI agent called Cryptonit that correlates market data with world events. Cryptonit needs CoinMarketCap Pro, which charges $0.01 per call via the x402 protocol. John writes a Markdown policy:

```markdown
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

He runs `leash apply cryptonit-policy.md`. Leash:

1. Generates a hub-owner key (stored in macOS Keychain or a local file).
2. Prints the **hub address** he needs to fund. John sends ~5 USDC on Base — that takes about 30 seconds.
3. He reruns `leash apply`, which deploys a **hub** (a Kernel smart account), a **sub-account** for Cryptonit (CREATE2-derived), installs a **session key** with the on-chain caps from the policy, and seeds the sub-account with the initial funding.
4. Leash writes `.mcp.json` at the repo root so Claude Code knows how to launch Leash as a stdio subprocess.

He opens Claude Code. Cryptonit asks for a BTC price. Claude Code launches Leash; Leash calls `coinmarketcap__get_price`; CMC returns HTTP 402 with an x402 challenge; Leash policy-checks (does this fit within today's budget?), signs an EIP-3009 authorization from Cryptonit's sub-account session key, retries; CMC returns the price; Leash logs the $0.01 to SQLite and forwards the result to the agent.

If Cryptonit goes rogue, `leash revoke cryptonit` kills the session key on-chain in one transaction. The next call fails at the contract layer — not at a polite "please stop" boundary.

## What you get

- **Curated upstream catalog.** Leash ships a hand-picked list of x402-enabled APIs, each verified end-to-end on mainnet. See [`upstreams.md`](upstreams.md) for the current list.
- **Per-agent sub-account on Base L2.** ZeroDev Kernel v3.3 smart accounts (ERC-4337 v0.7), one hub per user, one sub per agent. The hub never holds budget; the sub holds exactly what you fund.
- **On-chain session keys with witness-bearing 1271 signatures.** Per-recipient amount caps live on-chain via a custom ERC-7579 `SessionKeyValidator`. Sub-account compromise is bounded by the cap, not the balance.
- **Local-first.** Leash runs as a stdio subprocess inside Claude Code — no port, no Bearer token, no separate `leash serve` terminal. SQLite payment log on your disk. Operator state on your machine.
- **One-command revoke.** `leash revoke <agent>` is atomic and on-chain. No polite handshake.

## What it is not

- **Not a custodial service.** The hub-owner key is yours. There's no "Leash backend" between you and Base.
- **Not a generic x402 proxy.** Every upstream is a curated adapter (~30 LOC each). The MVP doesn't accept arbitrary URLs at runtime; it accepts ones from the catalog. The rationale is in `summary/upstream-strategy` (planning workspace) — the short version: real-world x402 implementations vary just enough that per-upstream adapters are cheaper than a permanent compatibility tax.
- **Not multi-chain at launch.** Base only. Multi-chain is post-launch consideration.
- **Not multi-agent yet.** The topology is forward-compatible (hub + factory model), but the CLI ships single-agent for the MVP.

## Three audiences

This doc set serves three readers; pages declare their audience at the top:

- **Users** — see [`quickstart.md`](quickstart.md), [`policy.md`](policy.md), [`cli.md`](cli.md).
- **Contributors** — see [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`adapter-guide.md`](adapter-guide.md), [`CLAUDE.md`](../CLAUDE.md).
- **Agents** (Claude Code in an agent's repo) — see [`mcp-tools.md`](mcp-tools.md), [`upstreams.md`](upstreams.md). The agent's own `CLAUDE.md` shipped with each example points to these.

## Status

Pre-launch. On-chain contracts live on Base mainnet; 10 upstreams live-verified end-to-end. 224 TypeScript tests + 66 Solidity fork tests green. See [`CHANGELOG.md`](../CHANGELOG.md) for what's shipped.
