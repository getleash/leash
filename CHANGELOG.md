# Changelog

All notable changes to Leash (the monorepo: `@getleash/core`, `@getleash/bundler`, `@getleash/mcp-server`, `@getleash/cli`, plus `contracts/`) will be documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); semver doesn't apply pre-launch.

## Unreleased

### On-chain EIP-3009 policy enforcement (witness-bearing signatures)

The SessionKeyValidator now enforces per-recipient amount caps and recipient allowlist on-chain for x402 / EIP-3009 payments, closing the asymmetry that previously left those checks off-chain in the MCP. The signature carries the EIP-3009 fields as witness bytes after the ECDSA portion; the validator rebuilds the USDC + Kernel-wrapped digest from the witness, requires equality against the supplied 1271 hash, then enforces `maxValueByRecipient[kernel][recipient]`. Apples-to-apples gas delta vs the previous hash-opaque path: +7.7k gas at the 1271-integration level, within the +8k acceptance ceiling.

**On-chain:**
- Replaced `contracts/src/SessionKeyValidator.sol` with the v2 witness-bearing variant. `onInstall` data shape extended from 5-tuple to 7-tuple (adds `address[] recipients, uint256[] recipientCaps`). 1271 path now expects `ECDSA(65) || abi.encode(to, value, validAfter, validBefore, nonce)` (225 bytes) as the inner signature.
- Production tests grew from 9 to 23 cases (`contracts/test/SessionKeyValidator.t.sol`); LeashIntegration + Security tests updated to the new install shape. 66/66 forge tests green on Base mainnet fork.
- Deployed v2 validator to:
  - **Base mainnet:** `0xF31271d1aA947B40bd1193b260dc2Ba48BD239E3` (tx `0x00b34b2e209d046863c32048664014daa544bf68702517b66d5cfc4bb318dcb5`)
  - **Base Sepolia:** `0xaB242Ae355Ab350c93d7cBB94Dd77a62c1AA35aF` (tx `0x6f7477b5973226cf71fa780e4d22f806bc79b6f8625942a5f294ce6b6d8d5007`)

**TypeScript:**
- `@getleash/core`: added `encodeEip3009Witness`, `buildWitnessOuter1271Signature`, `prefixSecondaryValidatorSignature`. New static registry `UPSTREAM_PAYTO` + `resolveUpstreamPayTo` for upstream settlement addresses (a probe-and-verify mode is a future enhancement).
- `@getleash/core/policy-parser`: accepts optional `max_per_call: <amt> USDC` per upstream, with cross-validation against `max_per_transaction`.
- `@getleash/cli`: `apply` now installs per-recipient caps. `buildInstallInitData` extended to 7-tuple.
- `@getleash/mcp-server`: x402 signing path emits the witness-bearing outer signature with the secondary-validator routing prefix (`0x01 || validator(20) || ECDSA(65) || witness(160)`). Fixed a latent bug — before this change the code prepended `0x00` (root-validator selector), which would not have validated against the non-root SessionKeyValidator in production.

**Gas:** apples-to-apples 1271 integration delta is +7,747 gas (109,772 → 117,519), inside the spike's +8k acceptance ceiling. UserOp path unchanged at 160k.

**Test counts:** 217 TS tests (was 209) + 66 forge tests (was 47).

**Breaking:** the on-chain validator's install data shape changed; any sub-account previously deployed against v1 cannot be reused with the v2 install path. No live user sub-accounts existed at the time of the change.

### Upstream rollout (12 curated x402 adapters)

Catalog scope: 20 → 10 → 12 over three rebaseline rounds. All 12 picks live-verified with raw curl (no SDK gatekeepers, no account signups).

**REST adapter framework:**
- `UpstreamAdapter` is now a discriminated union: `transport: 'mcp' | 'http-rest'`. CMC stays MCP-native; the other 11 are REST.
- New `RestHttpClient` (`packages/mcp-server/src/proxy/rest-client.ts`) implements the shared `UpstreamClient` interface alongside `McpHttpClient`. The 402 retry loop in `PaidToolCaller` is transport-agnostic.
- REST adapters declare a tool list (`name, description, inputSchema, method, path, headers?, bodyMode?`). Leash synthesizes MCP `tools/list` entries and translates each `tools/call` into one HTTP request with path-param substitution + JSON-body / query-string encoding.
- 7 new unit tests cover the REST path. The pre-existing CMC test suite stays green as a regression check.

**11 new adapters:**
- **browserbase** — Headless browser sessions ($0.01/5min, v1, body)
- **exa** — AI web search ($0.001–$0.007, v2, header)
- **neynar** — Farcaster social ($0.01, v2, body)
- **gloria** — Real-time news ($0.03, v2, body)
- **robtex** — DNS / IP intelligence ($0.005, **v1**, body)
- **orac** — AI safety / prompt-injection ($0.05–$0.10, v2, body)
- **agoragentic** — Document tools ($0.10, v2, body)
- **invy** — Onchain wallet lookup ($0.05, v2, header)
- **azursafe** — Wallet/identity risk screening ($0.01, v2, body)
- **mru-oracle** — Forex + economic data ($0.001, **v1**, body)
- **ottoai** — EVM tx + token explainer ($0.10, v2, body)

Categories covered: crypto data · browser · social · news · search · DNS intel · AI safety · doc tools · onchain lookup · risk screening · forex/macro · blockchain forensics (12 distinct).

Protocol coverage: 10 v2 + 2 v1 (Browserbase, Robtex, MRU Oracle). v1 hadn't been exercised in production code before this rollout; the existing 402 retry path handles both natively.

### Live mainnet smoke

Two rounds of end-to-end smoke against Base mainnet on 2026-05-12 settled real USDC payments through the witness-bearing signature path. Final catalog: **10 live-verified upstreams**.

**Passed (10):**
- coinmarketcap (v2 MCP, $0.01)
- exa (v2 REST, $0.001–0.007)
- neynar (v1 REST, $0.01)
- gloria (v1 REST, $0.03 — payment settled, tool returned 400 on bad sample args; adapter fine)
- orac (v2 REST, $0.05)
- agoragentic (v2 REST, $0.10)
- invy (v2 REST, $0.05)
- azursafe (v2 REST, $0.01)
- ottoai (v2 REST, $0.10)
- donate-0000402 (v2 REST, $0.01)

**Dropped after smoke (9):**
- browserbase — rotates payTo per call; incompatible with the witness validator's pre-installed `maxValueByRecipient` allowlist. Re-add path: future wildcard-cap opt-in mode (v1.1 roadmap).
- robtex, mru-oracle, x402factory — legacy v1 facilitators that strict-check 65-byte EOA sigs only; reject Leash's 246-byte witness sig. The x402 v1 spec **does** support ERC-1271 contract sigs (see `coinbase/x402` reference impl `isSmartWallet = sigLen > 130` branch); the barrier is upstream-side facilitator quality. Re-add path: operator updates their facilitator.
- proxy-0000402, tempfile-0000402, pastebin-0000402, timecapsule-0000402, human-0000402 — same operator + payTo as the working `donate-0000402` but their facilitator returns 402 with empty body on retry. Operator-side coverage gap.

Adapter files for all 9 dropped candidates kept under `packages/mcp-server/src/upstreams/` for one-line re-add when the upstream operators update their facilitators or settlement model.

**Smoke harness:** `scripts/smoke-upstreams.ts` — deploys a fresh sub via `LeashFactory.deploySubAccount`, installs `SessionKeyValidator` with all registered recipients (deduped by address with `max(cap)` so multi-namespace operators share one allowlist entry), seeds 0.75 USDC from hub, runs one tool call per upstream. Drain helpers at `scripts/drain-orphans.mts` + `scripts/drain-single.mts` recover USDC from old subs.

**Key engineering lessons:**
- **RPC consistency on freshly-deployed subs:** `installModule` tx mines successfully (`status=0x1`) but post-install state reads return stale 0x0 for ~3-5s on the load-balanced public RPC. Smoke harness now waits 5s post-install before reading sessions(sub). Production `leash apply` should adopt the same pattern.
- **viem's `writeContract` doesn't check receipt status** by default. We now check `receipt.status === 'success'` explicitly and verify on-chain state separately.
- **The 0000402.xyz pattern:** probe-cleanness ≠ settle-cleanness. An upstream can return a perfectly valid 402 challenge while having no working facilitator configured. Live mainnet smoke is the only binding evidence.
- **CDP and self-hosted modern facilitators handle witness sigs uniformly.** The witness-bearing signature `0x01 || sessionKeyValidator(20) || ECDSA(65) || abi.encode(witness)` is accepted by every facilitator that implements the smart-wallet sig path in the `coinbase/x402` reference impl.

**Total mainnet spend during the smoke rounds:** ~$0.84 USDC (recovered ~$0.45 via drain). Hub recovered to 0.97 USDC.

### Refactor + dedup pass

- Removed `temp/agent-wallet-architecture-update.md` (pre-pivot design artifact, not referenced).
- Removed `scripts/stubs/` (empty placeholder).
- `@getleash/core/index.ts`: `wrapForKernelManual` no longer exported — it's a parity guard used only by `kernel-wrap.test.ts`, which now imports it directly. Trims the public API.
- `@getleash/core/policy-parser.ts`: `SUPPORTED_UPSTREAMS` is now derived from `Object.keys(UPSTREAM_PAYTO)` instead of a hardcoded set. Adding a new upstream is now a single edit in `packages/core/src/upstream-payto.ts` (plus the adapter file in `@getleash/mcp-server/upstreams/`).
- All 217 TS tests + 66 forge tests stay green.
