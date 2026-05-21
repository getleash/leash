---
name: coding-sol
description: Conventions and traps for writing Solidity in this repo. Use whenever editing contracts/src/*.sol or contracts/test/*.sol, when adding a new validator/factory/paymaster surface, or when modifying signature verification, ERC-4337 v0.7 packing, or Kernel v3.3 envelope handling. Codifies the rules that aren't enforced by the compiler — pinned ABI submodules, dual-side digest tests, ERC-7579 install gating, USDC domain v2.
---

# Writing Solidity in Leash

Solidity in this repo is a small surface (3 contracts in `contracts/src/`) with disproportionately high stakes. The compiler catches type errors; almost every other class of bug here is a *protocol* bug — wrong byte layout, wrong domain version, wrong validator routing. This file is the short list of conventions that prevent those.

If you're doing a **security review** of contracts changes, use the `/security-audit` slash command — it has the structured findings checklist. This file is for *authoring* code.

## The three contracts and their stake

| File | Stake |
|---|---|
| `LeashFactory.sol` | CREATE2 deploys the hub Kernel + each sub-account. Bugs here = wrong deployment address = lost funds. |
| `SessionKeyValidator.sol` | ERC-7579 validator. Witness-bearing 1271 path. Per-recipient on-chain caps. Highest concentration of subtle bugs in the codebase. |
| `VerifyingPaymaster.sol` | Off-chain signer gates paymaster spend. Bugs here = gas griefing or paymaster drain. |

Do not add new contracts under `contracts/src/` without discussing in an issue first (CONTRIBUTING.md rule).

## Pinned dependencies (don't touch casually)

`contracts/lib/` contains submodules pinned to specific commits:
- `kernel` — Kernel v3.3
- `account-abstraction` — ERC-4337 v0.7 EntryPoint + helpers
- `openzeppelin-contracts` — for ECDSA, SignatureChecker, EIP-712

**Do not run `git submodule update` to "freshen" these.** Bumps are vetted manually. If you need a feature that requires a bump, open an issue with the proposed commit + a diff summary.

## ERC-4337 v0.7 only — never back-port to v0.6

PackedUserOperation packing rules (also in CLAUDE.md, repeated because it's the most-confused detail):

- `accountGasLimits` = `verificationGasLimit (16B) ‖ callGasLimit (16B)`, **big-endian.**
- `gasFees` = `maxPriorityFeePerGas (16B) ‖ maxFeePerGas (16B)`, **big-endian.**
- No separate `callGasLimit` field on the UserOp struct in v0.7. If you see that pattern, it's v0.6 contamination.

The TS bundler in `packages/bundler/` is v0.7-only. Solidity must match.

## Kernel v3.3 EIP-712 envelope

`isValidSignature` does **not** hash the raw payload — it wraps it first.

```solidity
bytes32 wrapperTypehash = keccak256("Kernel(bytes32 hash)");
// = 0x1547321c374afde8a591d972a084b071c594c275e36724931ff96c25f2999c83
bytes32 kernelDigest = _hashTypedDataV4(keccak256(abi.encode(wrapperTypehash, innerHash)));
```

Domain: `{name: "Kernel", version: "0.3.3", chainId, verifyingContract: address(this) /* sub-account */}`.

**`verifyingContract` is the sub-account**, NOT the validator and NOT the factory. Getting this wrong silently produces a different digest that no off-chain signer will match.

## Outer signature format (the 246-byte sig)

```
0x00 ‖ ECDSA(kernelDigest, 65 bytes)
   → routes to the root validator (hub-owned ECDSAValidator). 66 bytes total.

0x01 ‖ validatorAddress(20) ‖ ECDSA(kernelDigest, 65 bytes)
        ‖ abi.encode(to, value, validAfter, validBefore, nonce)
   → routes to a secondary validator (SessionKeyValidator) with witness payload.
     Total: 1 + 20 + 65 + 160 = 246 bytes.
```

Any change that touches signature parsing must update *both* the byte-length checks and the corresponding TS test in `packages/core/src/kernel-wrap.test.ts` that asserts the off-chain digest matches.

## USDC EIP-712 domain — `version: "2"`, NOT "2.2"

USDC on Base (FiatTokenV2_2) uses domain `version: "2"`. The contract is named V2_2 but the domain version field is "2". This is a documented trap and the most common copy-paste mistake when wiring up EIP-3009.

Domain:
```solidity
EIP712Domain({
  name: "USD Coin",
  version: "2",
  chainId: 8453,        // Base mainnet
  verifyingContract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
})
```

## ERC-7579 install gating

`installModule` / `uninstallModule` must be `_msgSender() == address(this)` gated. The intent is "only the Kernel itself can install a module on itself" — calls flow `EntryPoint → Kernel.execute → Kernel.installModule`, so `_msgSender()` returns the Kernel address (the contract itself).

If you write a new module-touching function, route it through the Kernel's executor; do not expose a direct external entrypoint.

The init data passed to a SessionKeyValidator install is a **7-tuple**. Mismatched ABI encoding produces a silent revert with no error string — the symptom is "installModule fails with empty revert data." Always cross-check the encoding against `packages/cli/src/commands/apply.ts::buildInstallInitData`.

## Witness rebuild path (the highest-risk surface)

Off-chain, the proxy signs over a wrapped Kernel digest and includes the witness bytes in the outer signature blob. On-chain, the validator must:

1. Slice the witness bytes from the outer sig at the **exact** offsets used off-chain.
2. Decode them as `(address to, uint256 value, uint48 validAfter, uint48 validBefore, bytes32 nonce)`.
3. Rebuild the EIP-3009 `TransferWithAuthorization` digest using the USDC domain (`version: "2"`, Base chainId, USDC address).
4. Wrap that digest in the Kernel envelope.
5. Compare with `==` against the `hash` argument passed to `isValidSignature`. **Any mismatch reverts.**
6. Then verify the ECDSA matches the session-key signer recorded in storage.
7. Then check the per-recipient cap: `maxValueByRecipient[kernel][to] > 0 && value <= maxValueByRecipient[kernel][to]`.

If you change *any* step's encoding, you must change the matching off-chain encoding in the same PR. The witness path is the one place where on-chain and off-chain code are tightly coupled at the byte level.

## Per-recipient cap is a separate storage write

`maxValueByRecipient[kernel][to]` is set at `registerSessionKey` time (or via `updateAllowedRecipients`). It is **independent** of the `allowedCalls` mapping that gates target/selector. A revoked session key must:

1. Zero out `sessions[kernel].signer` (the validator checks this first — sufficient to block).
2. Optionally clear other mappings for cleanliness (not strictly required for security, but tidy).

Don't write code that re-validates the cap if the signer is zero — it's wasted gas and may shadow the real check.

## Storage layout discipline (upgradeable contracts)

Any new storage variable in `SessionKeyValidator` or `VerifyingPaymaster` MUST be **appended** to the end of the storage layout. Mid-storage insertions corrupt every existing deployment.

If you're not sure whether a contract is upgradeable, assume it is, and append.

## Dual-side digest tests are mandatory

Any new EIP-712 typehash, witness layout, or domain change requires **two** new tests:

1. A TS test (in `packages/core/src/*.test.ts`) that builds the digest off-chain and asserts an exact byte value.
2. A Solidity test (in `contracts/test/*.sol`) that rebuilds the digest on-chain and asserts it equals the same byte value.

The whole point is that the two implementations agree. A test that only exercises one side proves nothing.

## Reentrancy & low-level calls

- `_call` / `_executeCall` must propagate reverts with their data, not swallow them.
- Be skeptical of any external call before a state write in `execute` / `executeBatch`. USDC has no hooks, but the pattern of "external call → balance-affecting state write" is the classic reentrancy footprint.
- Use Checks-Effects-Interactions even where it feels paranoid. Cheap to write, expensive to debug.

## Integer overflow & narrowing

- Solidity 0.8+ checks by default. Avoid `unchecked` blocks in signature validation, fund accounting, and expiry math.
- `block.timestamp` is `uint256`; if you store it as `uint48`, narrowing must be explicit and bounds-checked.

## Testing

- All forge tests run with `--fork-url $BASE_RPC_URL`. There's no off-fork unit test suite — every test exercises real Base mainnet state.
- New tests go into the **existing** `*.t.sol` file that covers the same contract. A new file only when you add a new contract.
- Security-focused tests should have `Security` in the contract name (e.g. `SessionKeyValidatorSecurity.t.sol`) so they're greppable for the `/security-audit` step.

## Comments where the protocol bites

Wherever a difference between v0.7 vs v0.6, Kernel-wrapped vs raw, or USDC domain v2 vs v2.2 could trip a future reader — leave a short comment citing CLAUDE.md or the spec. Generous comments in this codebase are load-bearing; they earn their keep the first time someone almost copies the wrong thing.

## Hard rules (recap)

- v0.7 only. No v0.6 fallbacks.
- USDC domain `version: "2"`, never "2.2".
- Kernel `verifyingContract` is the sub-account.
- ERC-7579 install gated to `_msgSender() == address(this)`.
- New typehash / witness change → tests on both sides in the same PR.
- Storage layout: append-only for upgradeable contracts.
- Don't bump submodules without vetting.
