# Leash — contributor guide for Claude Code

This is the implementation repo for **Leash** — an MCP proxy that lets AI agents pay for x402-enabled APIs using USDC on Base L2, with on-chain session keys and policy-enforced budgets. The goal of this file is to give Claude (and any human reading it) what they need to do useful work in this codebase without re-deriving project conventions every session.

Read [`README.md`](README.md) for the user-facing pitch and quickstart, [`CONTRIBUTING.md`](CONTRIBUTING.md) for what makes a good PR, and the prose comments in `packages/*/src/` — they're load-bearing.

## Building and running

```bash
git submodule update --init --recursive   # required: contracts/lib/{kernel, account-abstraction, openzeppelin-contracts}
npm install
npm run build --workspaces
npm test --workspaces
```

Contracts:

```bash
cd contracts
forge test --fork-url $BASE_RPC_URL       # 66 tests on a Base mainnet fork
```

Set `BASE_RPC_URL` to any Base RPC endpoint; the public one at `https://mainnet.base.org` is fine for tests. A `.env` is gitignored at the repo root — copy `.env.example` and fill in `BASE_RPC_URL` and (only when needed) `DEPLOYER_PRIVATE_KEY`.

## Testing

Two test surfaces, both must stay green before a PR is mergeable:

- **TypeScript:** `npm test --workspaces` runs 224 vitest cases across `packages/{core, bundler, mcp-server, cli}`.
- **Solidity:** `cd contracts && forge test --fork-url $BASE_RPC_URL` runs 66 forge cases on a Base mainnet fork (10 LeashFactory unit, 10 SessionKeyValidator, 2 LeashIntegration, 44 newer cases covering witness-bearing signature paths).

**Live mainnet smoke** (real USDC, real gas) lives in `scripts/` in the operator's private workspace — not in this repo. Public contributors do not need to run it; CI never runs it. If you need it for a deep investigation, ask the maintainer.

When you add a feature: extend the **existing** test file for the surface you're changing. New `*.test.ts` only when you're adding a wholly new module. Tests that depend on RPC behavior should use the fork (forge) or mock (`packages/mcp-server/src/proxy/*.test.ts` patterns), not hit live RPC.

## Repository structure

```
packages/
├── core/           # Shared types, ABIs, policy parser, Kernel-wrapped EIP-712
│                   # builder, x402 challenge parser, USDC EIP-3009 signer,
│                   # the canonical UPSTREAM_PAYTO registry.
├── mcp-server/     # The proxy. x402 middleware + 5 own tools + SQLite
│                   # payment log. Per-upstream adapters under src/upstreams/.
├── bundler/        # In-process ERC-4337 v0.7 bundler. No external rundler.
└── cli/            # `leash apply | serve | status | logs | fund | drain
│                   #  | revoke | doctor | export-backup | import-backup`.
contracts/
├── lib/                            # Submodules (kernel, eth-infinitism, OZ).
├── src/
│   ├── LeashFactory.sol            # CREATE2 deploy of Kernel proxies +
│   │                               # hub/sub tracking.
│   ├── SessionKeyValidator.sol     # ERC-7579 validator with witness-bearing
│   │                               # 1271 path; enforces target/selector/
│   │                               # amount + per-recipient EIP-3009 caps.
│   └── VerifyingPaymaster.sol      # Off-chain signature-gated paymaster.
└── test/
examples/
├── cryptonit/                      # First-time UX example (1 upstream).
└── verify-grant/                   # On-chain verification helper.
scripts/                            # Public infra: sync-abis, sync-deployments,
                                    # generate-keys, demo-skeleton.
tests/fixtures/upstream-probes/     # Raw 402 challenges captured live;
                                    # treat as golden test fixtures.
```

## Code architecture

The proxy + signer + bundler triad, in dataflow order:

```
Claude Code → MCP stdio → mcp-server/server.ts
                              ├── tools/      (own tools: balance, budget, pay, transfer, revoke)
                              ├── proxy/      (per-upstream proxy; intercepts 402, signs, retries)
                              └── upstreams/  (per-upstream adapters; declared quirks only)

mcp-server signs by:
  1. Parsing the 402 challenge via core/x402.ts
  2. Building the EIP-3009 TransferWithAuthorization digest via core/x402.ts
  3. Wrapping in Kernel's EIP-712 envelope via core/kernel-wrap.ts
  4. Encoding the witness-bearing outer signature: 0x01 || validator(20) || ECDSA(65) || abi.encode(witness)
  5. Submitting via the upstream's required retry header (X-PAYMENT for v1, Payment-Signature for v2)

UserOp actions (transfer, revoke_session_key) flow through:
  cli or mcp-server → bundler → EntryPoint v0.7 → Kernel sub-account → SessionKeyValidator
```

The split between **on-chain policy** (SessionKeyValidator) and **local policy** (SQLite counters in `mcp-server/db.ts`) is deliberate. On-chain enforces target + selector + per-tx amount + per-recipient EIP-3009 amount — the cap nobody can bypass. SQLite enforces rolling daily/weekly/monthly windows — the agent's negotiated budget envelope.

## Key technical details

These are the tricky bits. Most subtle bugs trace back to one of them.

### ERC-4337 v0.7 (PackedUserOperation)

- `accountGasLimits` = verificationGasLimit (16B) ‖ callGasLimit (16B), big-endian.
- `gasFees` = maxPriorityFeePerGas (16B) ‖ maxFeePerGas (16B), big-endian.
- The bundler in `packages/bundler/` is **v0.7-only.** Don't try to back-port to v0.6.

### Kernel v3.3 + ERC-7579 validators

ERC-1271 `isValidSignature` does **not** hash the raw payload directly — it wraps it in a Kernel-specific EIP-712 envelope, then routes to the active validator. Wrapper typehash:

```solidity
keccak256("Kernel(bytes32 hash)")
// = 0x1547321c374afde8a591d972a084b071c594c275e36724931ff96c25f2999c83
```

Domain: `{name: "Kernel", version: "0.3.3", chainId, verifyingContract: subAccount}`.

The outer signature's first byte selects the validator:
- `0x00 ‖ ECDSA(kernelDigest, 65 bytes)` → root validator (hub-owned ECDSAValidator), full override.
- `0x01 ‖ validatorAddress(20) ‖ ECDSA(kernelDigest, 65 bytes) ‖ abi.encode(to, value, validAfter, validBefore, nonce)` → secondary validator (SessionKeyValidator) with witness payload. Total: **246 bytes**.

The witness path is what makes per-recipient on-chain caps work — see `summary` linked from `CONTRIBUTING.md` if you need the full design rationale; the short version is in `contracts/src/SessionKeyValidator.sol` comments.

### USDC on Base (FiatTokenV2_2)

- EIP-712 domain `version` is `"2"`, **not `"2.2"`**. This is a common trap.
- 6 decimals; all internal math in bigint base units.
- USDC's `SignatureChecker` accepts ERC-1271 contract sigs — this is what makes `transferWithAuthorization` work against a smart-account signer.

### x402 protocol versions

Both v1 and v2 are supported by adapters; signing is identical.

| Version | Retry header | Detection |
|---|---|---|
| v1 | `X-PAYMENT` | `challenge.x402Version === 1` |
| v2 | `Payment-Signature` | `challenge.x402Version === 2` |

`@getleash/core::encodeRetryHeader` picks the right header automatically. Adapters declare `x402Version`; the proxy does the rest.

**Facilitator compatibility:** Leash works with any x402 facilitator that implements ERC-1271 contract-signature verification (the `isSmartWallet = sigLen > 130` branch from the reference impl). Legacy self-hosted facilitators that strict-check 65-byte EOA sigs **do not work** with Leash and never will from this side — the upstream operator has to update their facilitator. We've documented the pattern; don't try to "fix" this in the adapter.

### Gas estimation defaults

```
verificationGasLimit: 500_000
callGasLimit:         300_000
preVerificationGas:   100_000
```

Generous on purpose — bundler simulation is the safety net, not gas estimation accuracy.

### Key contract addresses (Base mainnet)

- EntryPoint v0.7: `0x0000000071727De22E5E9d8BAf0edAc6f37da032`
- USDC (FiatTokenV2_2): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Leash SessionKeyValidator: `0xF31271d1aA947B40bd1193b260dc2Ba48BD239E3`
- Kernel v3.3 factory + implementation: see `packages/core/src/constants.ts`.

## Adding an upstream adapter

The single highest-value contribution. Skill **`writing-x402-adapters`** under `.claude/skills/` is the full walkthrough — invoke it (or read its `SKILL.md`) when you start. High-level steps:

1. Capture the upstream's live 402 challenge into `tests/fixtures/upstream-probes/<name>.json`.
2. Add a `payTo` entry to `packages/core/src/upstream-payto.ts`.
3. Author the adapter in `packages/mcp-server/src/upstreams/<name>.ts` (use `coinmarketcap.ts` for MCP-mode upstreams, `exa.ts` for REST).
4. Register in `packages/mcp-server/src/upstreams/registry.ts`.
5. Write a unit test under the adapter's directory.
6. The maintainer runs the live-mainnet smoke before merge — probe-cleanness ≠ settle-cleanness, so don't claim "works" until the smoke confirms it.

Inclusion filter: permissionless (no API-key signup), USDC on Base, $0.001–$0.50 per call, stable URL backed by working docs or a verified live endpoint. Open an issue first with the candidate's raw 402 response so we don't duplicate work.

## Documentation-first workflow

Anything that changes a user-visible surface — a new CLI command or flag, a new policy field, a new error code, a new MCP tool, a new upstream adapter, a renamed config key — **updates `docs/` first.** The doc is the contract; the code satisfies the doc.

This is the same principle as the project's "UX freeze before code" policy from the planning phase, applied continuously. Most scope and naming problems surface when you try to write the doc and discover the change doesn't read cleanly. Better to find that out before the code and tests ossify around a bad choice.

Concretely, before writing or modifying production code that touches a user-visible surface:

1. Identify which `docs/*.md` page covers it. If none does, add an entry in `docs/README.md` and create the page.
2. Write or update the doc section. Show the exact CLI invocation, policy syntax, tool schema, error shape, or example output the user will see. The doc should read as if the feature already exists.
3. **Then** write the code and tests so they match what the doc says.

Skip the docs step only for:

- Pure internal refactors with no user-visible diff.
- Bug fixes that restore documented behavior — note them in `CHANGELOG.md` instead.
- Operator-only scripts that don't live in this repo.

The code-review self-check below has a line item for this. A PR that adds a CLI flag, a policy field, an error code, or a tool without a matching `docs/` change is incomplete.

## Code review self-check

Before opening a PR, walk through:

- [ ] `npm test --workspaces` green.
- [ ] `cd contracts && forge test --fork-url $BASE_RPC_URL` green.
- [ ] No `.env`, no private keys, no session keys in the diff. `git diff --stat` is your friend.
- [ ] Any new signed-message format (EIP-712 typehash, witness layout, etc.) has both a TS test asserting the digest and a Solidity test asserting on-chain rebuild produces the same digest.
- [ ] Any new policy field has a parser test with a clear error message + line number.
- [ ] Any new adapter has a unit test referencing a fixture in `tests/fixtures/upstream-probes/`.
- [ ] Public-facing files (`README.md`, `CONTRIBUTING.md`, anything users see) match the rest of the project's tone — direct, honest, no marketing fluff.
- [ ] Any user-visible surface change (CLI command, flag, policy field, error code, MCP tool, upstream adapter) has a matching `docs/` update in the same PR — see "Documentation-first workflow" above.

## Important development notes

- **Session keys never touch disk.** They live in-memory inside the `leash serve` subprocess, derived from the encrypted agent config. Any PR that writes a session key to a file is a hard reject.
- **`.env` is for local secrets only.** Never commit one. `.env.example` is the contract — keep it minimal and well-commented.
- **Real money lives behind clear gates.** Anything that signs and broadcasts a transaction to Base mainnet must (a) read its config from env, (b) print a confirmation summary, and (c) require explicit operator action — no auto-broadcast on a script's happy path. Sepolia testnet first when you can.
- **Generous comments where the protocol is subtle.** Anywhere a v0.7-vs-v0.6 difference, a Kernel-wrapped vs. raw signature, or a v1-vs-v2 x402 quirk could trip a future reader — leave a comment with the source of truth.
- **Submodules are pinned.** `contracts/lib/kernel`, `contracts/lib/account-abstraction`, `contracts/lib/openzeppelin-contracts` are pinned to specific commits. Don't `git submodule update` casually — verify the new commits are vetted before bumping.
- **No backwards-compat scaffolding before a surface is published.** When you change an internal API, change the callers in the same PR. Don't leave aliases or `// removed` comments. Once a package surface ships on npm, the rules change — until then, keep the diff clean.

## Debugging notes

- **CI failures:** GitHub Actions wiring is not landed yet; treat local green tests as the bar until CI is set up.
- **`forge test` flake on the public RPC:** the public Base RPC is load-balanced; if you see intermittent fork-test flakes, set `BASE_RPC_URL` to a dedicated RPC (Alchemy, QuickNode, etc.) and rerun. The TS proxy code already uses viem's `http(url, { retryCount, retryDelay })`; if you're seeing flakes from new code, mirror that pattern.
- **`installModule` revert with no error:** SessionKeyValidator's init data is a 7-tuple; mismatched ABI encoding is the most common cause. See `packages/cli/src/commands/apply.ts::buildInstallInitData`.
- **Post-deploy / post-install state reads return stale data.** After deploying a contract or calling `installModule` against a load-balanced public RPC (e.g. `https://mainnet.base.org`), the transaction receipt may be confirmed before all RPC nodes have caught up. A read like `sessionKeyValidator.sessions(subAccount)` can return zeroed state for **3–5 seconds** after the receipt comes back. The fix is to wait briefly and use a retry transport. Production code under `packages/` already does this via `http(url, { retryCount: 5, retryDelay: 2000 })`; deploy and install scripts should sleep ~5s after broadcast before any state assertion. Using a dedicated RPC (Alchemy, QuickNode) instead of the public endpoint removes the lag.
- **Facilitator returned 4xx on retry:** check sig length first. 65 bytes = old-style EOA sig (should never happen from Leash); 246 bytes = witness sig (expected). If the facilitator rejects 246-byte sigs, it's a legacy facilitator and the upstream needs to update theirs — not a Leash bug.
