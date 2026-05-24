# Leash — contributor guide for Claude Code

MCP proxy for AI agents paying x402-enabled APIs in USDC on Base L2, with on-chain session keys and policy-enforced budgets. See [`README.md`](README.md) for the user pitch, [`docs/`](docs/) for the user/agent/contributor reference, [`CONTRIBUTING.md`](CONTRIBUTING.md) for PR expectations. Comments in `packages/*/src/` are load-bearing — read them.

## Build + test

```bash
git submodule update --init --recursive   # contracts/lib/{kernel, account-abstraction, openzeppelin-contracts}
npm install && npm run build
npm test --workspaces                                   # 224 vitest cases
cd contracts && forge test --fork-url $BASE_RPC_URL     # 66 forge cases, Base mainnet fork
```

`BASE_RPC_URL` defaults to `https://mainnet.base.org` (fine for tests; switch to Alchemy/QuickNode for steady-state). Copy `.env.example` → `.env` for `BASE_RPC_URL` and (when needed) `DEPLOYER_PRIVATE_KEY`. Both `.env` and any `*.db` are gitignored.

Live mainnet smoke (real USDC, real gas) lives outside this repo. Public contributors don't run it; CI doesn't run it. The maintainer runs it before promoting an upstream from "Deferred" to "Available" in `docs/upstreams.md`.

When extending: edit the existing test file for the surface you change; new `*.test.ts` only for a wholly new module. RPC-dependent tests use the forge fork or the `packages/mcp-server/src/proxy/*.test.ts` mocks — never live RPC.

## Layout

```
packages/
├── core/         types, ABIs, policy parser, Kernel-wrapped EIP-712 builder,
│                 x402 parser, EIP-3009 signer, UPSTREAM_PAYTO registry.
├── mcp-server/   the proxy: x402 middleware + 5 own tools + SQLite log;
│                 adapters under src/upstreams/.
├── bundler/      in-process ERC-4337 v0.7 bundler (no external rundler).
└── cli/          leash apply | serve | status | logs | fund | drain |
                  revoke | doctor | export-backup | import-backup.
contracts/
├── src/
│   ├── LeashFactory.sol         CREATE2 Kernel proxies + hub/sub tracking.
│   ├── SessionKeyValidator.sol  ERC-7579 validator; witness-bearing 1271;
│   │                            target+selector+amount+per-recipient caps.
│   └── VerifyingPaymaster.sol   off-chain signature-gated paymaster.
└── lib/                         pinned submodules.
docs/                            user/agent/contributor reference; see docs/README.md.
examples/                        cryptonit (1 upstream), verify-grant.
scripts/                         sync-abis, sync-deployments, generate-keys, demo-skeleton.
tests/fixtures/upstream-probes/  captured 402 challenges; golden test fixtures.
```

## Architecture

```
Claude Code → MCP stdio → mcp-server/server.ts
                          ├── tools/      own: balance, budget, pay, transfer, revoke
                          ├── proxy/      intercepts 402, signs, retries
                          └── upstreams/  per-upstream adapters; declared quirks only

x402 signing path:
  1. core/x402.ts parses the 402 challenge
  2. core/x402.ts builds the EIP-3009 TransferWithAuthorization digest
  3. core/kernel-wrap.ts wraps in Kernel EIP-712
  4. emits witness sig: 0x01 ‖ validator(20) ‖ ECDSA(65) ‖ abi.encode(witness)   // 246 B
  5. retries via X-PAYMENT (v1) or Payment-Signature (v2)

UserOps (transfer, revoke):
  cli or mcp-server → bundler → EntryPoint v0.7 → Kernel sub → SessionKeyValidator
```

**Policy split.** On-chain (SessionKeyValidator) enforces target + selector + per-tx amount + per-recipient EIP-3009 amount — the cap nobody bypasses. SQLite (`mcp-server/db.ts`) enforces rolling daily/weekly/monthly windows — the negotiated budget envelope. Deliberate; don't consolidate.

## Tricky bits

Most subtle bugs trace back to one of these.

### ERC-4337 v0.7 packing
- `accountGasLimits` = verificationGasLimit(16B) ‖ callGasLimit(16B), big-endian.
- `gasFees`          = maxPriorityFeePerGas(16B) ‖ maxFeePerGas(16B), big-endian.
- Bundler is **v0.7-only.** Don't back-port to v0.6.

### Kernel v3.3 1271 wrapper

`isValidSignature` does **not** hash the raw payload — it wraps in Kernel EIP-712, then routes by the outer sig's first byte:

```
typehash = keccak256("Kernel(bytes32 hash)")
         = 0x1547321c374afde8a591d972a084b071c594c275e36724931ff96c25f2999c83
domain   = {name:"Kernel", version:"0.3.3", chainId, verifyingContract: subAccount}

0x00 ‖ ECDSA(65B)                                                   → root validator (hub-owned)
0x01 ‖ validator(20B) ‖ ECDSA(65B) ‖ abi.encode(to,value,vA,vB,n)   → SessionKeyValidator + witness (246 B)
```

The witness path is what makes per-recipient on-chain caps work. Design notes in `contracts/src/SessionKeyValidator.sol` comments.

### USDC on Base (FiatTokenV2_2)
- EIP-712 domain `version: "2"` (**not** `"2.2"`). Common trap.
- 6 decimals; all internal math in bigint base units.
- `SignatureChecker` accepts ERC-1271 — that's what makes `transferWithAuthorization` work against a smart account.

### x402 v1 / v2

Both supported. Signing is identical; only the retry header differs.

| Version | Retry header | Detection |
|---|---|---|
| v1 | `X-PAYMENT` | `challenge.x402Version === 1` |
| v2 | `Payment-Signature` | `challenge.x402Version === 2` |

`@getleash/core::encodeRetryHeader` picks. Adapters declare `x402Version`; the proxy does the rest.

**Facilitator compatibility.** Leash works with any x402 facilitator that implements ERC-1271 contract-sig verification (the `isSmartWallet = sigLen > 130` branch from `coinbase/x402`'s reference impl). Legacy facilitators that strict-check 65-byte EOA sigs **do not work** and never will from this side — upstream operator must update. Don't "fix" this in the adapter.

### Gas defaults

```
verificationGasLimit: 500_000
callGasLimit:         300_000
preVerificationGas:   100_000
```

Generous on purpose — bundler simulation is the safety net.

### Base mainnet addresses
- EntryPoint v0.7: `0x0000000071727De22E5E9d8BAf0edAc6f37da032`
- USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- SessionKeyValidator: `0xF31271d1aA947B40bd1193b260dc2Ba48BD239E3`
- Kernel v3.3 factory + impl: `packages/core/src/constants.ts`.

## Adding an upstream

Highest-leverage contribution. Full walkthrough: skill `writing-x402-adapters` under `.claude/skills/`. Steps:

1. Capture the upstream's live 402 into `tests/fixtures/upstream-probes/<name>.json`.
2. Add a `payTo` to `packages/core/src/upstream-payto.ts`.
3. Author `packages/mcp-server/src/upstreams/<name>.ts` (MCP-mode: copy `coinmarketcap.ts`; REST: copy `exa.ts`).
4. Register in `packages/mcp-server/src/upstreams/registry.ts`.
5. Unit test against the fixture.
6. Maintainer runs the live smoke before merge — probe-cleanness ≠ settle-cleanness.

Inclusion filter: permissionless, USDC on Base, $0.001–$0.50/call, stable URL. Open an issue first with the raw 402.

## Documentation-first workflow

Anything that changes a user-visible surface — CLI command/flag, policy field, error code, MCP tool, upstream adapter, renamed config key — **updates `docs/` first.** The doc is the contract; the code satisfies the doc.

Procedure:

1. Find the `docs/*.md` page covering the surface (add a row to `docs/README.md` + create the page if none does).
2. Write the doc showing the exact invocation / schema / error shape the user will see. Reads as if the feature exists.
3. Then write the code and tests to match.

Skip only for: pure internal refactors (no user-visible diff), bug fixes restoring documented behavior (note in `CHANGELOG.md`), operator-only scripts (not in this repo).

A PR adding a flag, field, code, or tool without a matching `docs/` change is incomplete.

## PR self-check

- [ ] `npm test --workspaces` green.
- [ ] `cd contracts && forge test --fork-url $BASE_RPC_URL` green.
- [ ] No `.env`, no private keys, no session keys in the diff (`git diff --stat`).
- [ ] New signed-message format (EIP-712 typehash, witness layout) has both a TS digest test and a Solidity on-chain-rebuild test.
- [ ] New policy field has a parser test with a clear error message + line number.
- [ ] New adapter has a unit test against a fixture in `tests/fixtures/upstream-probes/`.
- [ ] Public-facing files (`README.md`, `CONTRIBUTING.md`, `docs/`) match the project tone — direct, honest, no marketing fluff.
- [ ] Any user-visible surface change has a matching `docs/` update in the same PR (see "Documentation-first workflow").

## Hard rules

- **Session keys never touch disk.** In-memory in `leash serve`, derived from the encrypted agent config. PR that writes one to a file is a hard reject.
- **`.env` is local-only.** Never commit. `.env.example` is the contract — minimal and well-commented.
- **Real-money paths gate clearly.** Anything that signs + broadcasts to Base mainnet must (a) read config from env, (b) print a confirmation summary, (c) require explicit operator action. No auto-broadcast on a script's happy path. Sepolia first when you can.
- **Comment subtle protocol bits.** v0.7-vs-v0.6, Kernel-wrapped vs raw sig, v1-vs-v2 x402 — leave the source of truth in a comment.
- **Submodules are pinned.** Don't `git submodule update` casually — `contracts/lib/{kernel,account-abstraction,openzeppelin-contracts}` are at specific vetted commits.
- **No backwards-compat scaffolding pre-npm.** Change callers in the same PR. No aliases, no `// removed` comments. Rules change once a surface ships on npm; until then, keep diffs clean.

## Debugging cheatsheet

| Symptom | Cause | Fix |
|---|---|---|
| `forge test` flakes | Public Base RPC is load-balanced | Set `BASE_RPC_URL` to Alchemy/QuickNode. TS code uses viem `http(url, { retryCount, retryDelay })` — mirror that pattern in new code. |
| `installModule` revert with no error data | SessionKeyValidator init data is a 7-tuple; ABI encoding mismatch | See `packages/cli/src/commands/apply.ts::buildInstallInitData`. |
| Post-deploy / post-install state reads return 0x0 for 3–5 s | Load-balanced RPC catches up after the receipt mines | Sleep ~5 s in deploy/install scripts before any state assertion. Production code uses `http(url, { retryCount: 5, retryDelay: 2000 })`. A dedicated RPC removes the lag. |
| Facilitator returns 4xx on retry | 65 B sig = old EOA (shouldn't happen from Leash); 246 B = witness (expected). 4xx on 246 B = legacy facilitator | Upstream operator updates their facilitator. Not a Leash bug. |
| CI failures | GH Actions wiring not landed yet | Local green tests are the bar until CI is set up. |
