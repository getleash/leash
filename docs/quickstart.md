# Quickstart

> **Audience:** first-time user. Goal: a working Leash setup with one paid API call in ~5 minutes plus the time to send 5 USDC on Base.

## Prerequisites

- macOS or Linux. Node 20+. Bash or zsh.
- A wallet you control on Base mainnet with **~5 USDC** to fund the agent's hub. You'll send these to an address Leash prints in step 4.
- A Base RPC endpoint. The public one at `https://mainnet.base.org` works for getting started; for production you'll want Alchemy / QuickNode.
- Claude Code installed locally. (Other stdio MCP clients work, but Claude Code is what's tested.)

## 1. Install the CLI

```bash
npm install -g @getleash/cli
leash --version    # leash 0.1.0
```

## 2. Set up a policy

Copy the starter agent's files into your project root:

```bash
cp <path-to-leash-repo>/examples/cryptonit/cryptonit-policy.md ./
cp <path-to-leash-repo>/examples/cryptonit/CLAUDE.md           ./
```

Open `cryptonit-policy.md` and skim it — every field is documented in [`policy.md`](policy.md). The defaults work for a first run.

## 3. Run `leash apply` (first time)

```bash
export BASE_RPC_URL=https://mainnet.base.org
leash apply cryptonit-policy.md
```

On the first run, Leash:

1. Generates a hub-owner private key.
2. Stores it in your macOS Keychain (or in `.leash/<agent>/keys/` on Linux — see `LEASH_KEY_STORE`).
3. Prints the **hub address** that needs funding and exits.

You'll see something like:

```
Leash: created hub-owner key for cryptonit.
       Send ~5 USDC on Base to:

           0x40B52DEFE2a2fC0441ceF9Fbd3B725A261eec6d0

       Then rerun `leash apply cryptonit-policy.md` to complete setup.
```

## 4. Fund the hub

Send 5 USDC on Base to the address printed above. Any wallet works — Coinbase, MetaMask, Rabby. Confirmation takes ~30 seconds.

> **Tip:** the hub holds the budget pool. Each agent's sub-account is funded from the hub at `apply` time with the policy's `initial_funding` amount. You can refund mid-life with `leash fund <agent> <amount>`.

## 5. Run `leash apply` again

```bash
leash apply cryptonit-policy.md
```

This time Leash:

1. Deploys your **hub** (a Kernel v3.3 smart account, ~270k gas).
2. Deploys the agent's **sub-account** via CREATE2 (~270k gas).
3. Installs the `SessionKeyValidator` on the sub with the per-recipient caps from your policy.
4. Seeds the sub with `initial_funding` USDC from the hub.
5. Writes `.mcp.json` in the current directory with the right stdio launch command.

Gas is sponsored by Leash's `VerifyingPaymaster`, so the funding flow needs USDC only — no ETH required from you. (The maintainer covers the gas; see `summary/business-model-stance` in the planning workspace for the rationale.)

## 6. Open Claude Code

In the same directory:

```bash
claude
```

Claude Code reads `.mcp.json`, launches Leash as a stdio MCP subprocess, and the upstream's tools appear in Claude's tool list. For cryptonit's policy, you'll see `coinmarketcap__get_price` (and Leash's own tools — `get_balance`, `get_api_budget`, `transfer`, `revoke_session_key`, `pay_for_api`).

## 7. First paid call

Ask Claude something the agent needs the upstream for:

```
What's BTC's current price?
```

Claude calls `coinmarketcap__get_price`. CMC returns HTTP 402 with an x402 challenge. Leash:

1. Looks up the upstream's payTo address from its adapter.
2. Policy-checks: does this fit `max_per_transaction`? Does it fit `daily_limit` net of today's spend?
3. Signs an EIP-3009 `TransferWithAuthorization` from the sub-account session key, wrapped in Kernel's EIP-712 envelope, with the witness payload routed through the `SessionKeyValidator`.
4. Retries the upstream with the signed payment header.
5. CMC's facilitator verifies the signature, settles the USDC on-chain, returns the price.
6. Leash logs the call to SQLite and forwards the result to Claude.

You see the price. SQLite at `~/.leash/<agent>/leash.db` (Linux) or `~/Library/Application Support/leash/<agent>/leash.db` (macOS) now has one row in the `payments` table.

## Day-two commands

```bash
leash status cryptonit      # sub-account balance, spend windows, key expiry
leash logs cryptonit -f     # follow the payment log in real time
leash fund cryptonit 2.00   # top up the sub from the hub
leash drain cryptonit       # pull all USDC back to the hub
leash revoke cryptonit      # kill the session key on-chain (atomic)
```

Full reference: [`cli.md`](cli.md).

## When things go wrong

- **`leash apply` says "hub not funded yet"** — your USDC transfer hasn't confirmed, or you sent it to the wrong address. Check Basescan for the hub address printed in step 3.
- **Claude doesn't see Leash tools** — confirm `.mcp.json` exists in the directory you launched Claude from. Run `leash doctor cryptonit` for a structured check.
- **Upstream returns `FACILITATOR_REJECTED`** — that upstream's facilitator may be a legacy v1 implementation. The catalog only ships upstreams that work end-to-end, but upstream operators occasionally regress. Check [`upstreams.md`](upstreams.md) for the live status table.
- **`INSUFFICIENT_FUNDS` from a tool call** — the sub-account doesn't have enough USDC for this call's cost. Run `leash fund <agent> <amount>` to top up, or expand the policy's limits.

For the full error code list and what each one means, see [`mcp-tools.md`](mcp-tools.md#error-codes).

## What you have now

- A funded hub on Base mainnet you control.
- An agent sub-account whose blast radius is bounded by its balance.
- An on-chain session key with per-recipient caps that nobody — not even you — can bypass without `leash revoke`.
- A local SQLite log of every payment.
- A working agent that pays for an API call per-use, in USDC, with no API key in your shell history.

Next: read [`policy.md`](policy.md) to scope a real policy for your use case, then [`upstreams.md`](upstreams.md) for what else is reachable.
