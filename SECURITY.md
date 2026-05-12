# Security policy

Leash handles real money (USDC on Base L2) signed by session keys that an AI agent holds. We take security seriously and welcome reports from anyone who finds an issue.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.** Please email **stepan.kouba@gmail.com** with:

- A description of the vulnerability and its impact.
- Steps to reproduce, including any test transactions, contract addresses, or sample policies.
- Whether you've shared the issue with anyone else.

You'll get an acknowledgement within 72 hours. We'll work with you on a fix, a disclosure timeline, and credit if you'd like it.

## Scope

In scope:
- Smart contracts in `contracts/src/` (LeashFactory, SessionKeyValidator, VerifyingPaymaster) — anything that lets an attacker move funds beyond the policy bounds, bypass the session-key allowlist, or compromise the hub-owner authority.
- TypeScript packages (`@getleash/core`, `@getleash/cli`, `@getleash/mcp-server`, `@getleash/bundler`) — signature-construction bugs, policy-bypass paths, credential mishandling (keys written to disk, leaked in logs, etc.), prompt-injection vectors that escalate to financial loss.
- The CLI's keychain / session-key storage.
- Build / supply-chain issues affecting published npm packages.

Out of scope:
- Issues that require physical access to the operator's machine after they've already authenticated.
- DoS via excessive RPC requests against public Base RPCs (operator concern, not Leash's).
- Findings against upstream dependencies (please report to those projects directly; we'll mirror once they have a CVE).
- Findings only reproducible on testnets where the operator has explicitly funded a test sub-account beyond `daily_limit` — pre-production exploration is exactly what testnets are for.

## Disclosure

We aim to ship a fix within 30 days of confirming a high-severity issue. We'll coordinate the public disclosure window with the reporter — typically 7 days after a fix is released, longer if the bug exposes deployed user sub-accounts.

## What Leash does not promise

- No external audit yet. We commit to commissioning one before any single sub-account aggregates more than ~$100 USDC of real-world load. Until then, Leash is "internal review + community eyes" only.
- The MCP server runs as a stdio subprocess inside the operator's machine; if that machine is compromised, the session key is compromised — that's the threat model, not a bug. Worst-case loss on any compromise is the sub-account's current balance. (Hub-owner key compromise is a separate event with broader recovery implications.)
- Hub-owner key safety is on the operator. We store it in Keychain on macOS by default; loss of the hub-owner key means loss of authority to recover the sub-account.
