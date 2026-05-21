---
description: Run a comprehensive security audit on the Solidity contracts. Runs the test suite, then does a manual code review for common vulnerability patterns. Produces a CRITICAL / HIGH / MEDIUM / LOW / INFO findings report.
allowed-tools: Bash(forge:*), Bash(git diff:*), Bash(git log:*), Bash(git grep:*), Bash(ls:*), Bash(rg:*), Read, Grep, Glob
---

Run a comprehensive security audit on the Leash Solidity contracts. Work step-by-step; report at the end.

## Step 1 — run security-focused tests

From the `contracts/` directory:

```bash
forge test --fork-url $BASE_RPC_URL --match-contract Security -vvv
```

Report pass/fail counts. If any fail, investigate before continuing.

## Step 2 — run the full suite

```bash
forge test --fork-url $BASE_RPC_URL
```

Confirm nothing is broken. Report the total test count.

## Step 3 — manual code review

Read every `.sol` file in `contracts/src/` (`LeashFactory.sol`, `SessionKeyValidator.sol`, `VerifyingPaymaster.sol`) and check the categories below. For each finding, note severity (CRITICAL / HIGH / MEDIUM / LOW / INFO), the file/line, and a one-paragraph explanation.

### Access control
- Are all state-changing functions gated correctly (onlyOwner, EntryPoint-only, hub-only)?
- Can any external function be called by an unauthorized address with adverse effect?
- Is the `initialize` function (where present) protected against re-initialization?
- For ERC-7579 module install/uninstall: who can install? Who can uninstall? Is the access path restricted to the Kernel itself via `_msgSender()`?

### Signature validation
- Does `_validateSignature` correctly route between the root validator and the SessionKeyValidator (validator-selector first byte)?
- Are signatures validated using OpenZeppelin's `ECDSA` / `SignatureChecker` (not raw `ecrecover`)?
- Are malformed signatures handled — wrong length, high-s, zero-length?
- Is `userOpHash` chain-specific (includes `chainId`)?
- For the witness-bearing 1271 path: is the witness re-encoded and re-hashed on-chain, and is the result strictly compared against the wrapped `kernelDigest`? Any place where a witness could be substituted post-signature would be CRITICAL.

### Session-key constraints
- Can a session key escalate privileges (call `registerSessionKey`, `revokeSessionKey`, `installModule`, or any factory function on the hub)?
- Does revocation actually block the key — even if the `allowedCalls` / `maxValueByRecipient` mappings remain populated, is the validator's `sessions[kernel].signer == address(0)` check sufficient?
- Is calldata validation correct for both `execute` and `executeBatch`? Are short calldata, empty batch, mismatched selector, and selector-collision edge cases rejected?
- Per-recipient amount cap: does the validator reject when `maxValueByRecipient[kernel][to] == 0`, and reject when `value > maxValueByRecipient[kernel][to]`?

### Paymaster (`VerifyingPaymaster`)
- Does the verifying hash include every UserOp field that matters (sender, nonce, callData, all gas fields, paymasterAndData fields excluding the signature itself)?
- Does the hash include `chainId` and `address(this)` (the paymaster address)?
- Is `paymasterData` length strictly validated? Truncating bugs there bypass the signer.
- Are `validUntil` / `validAfter` boundaries correct? `validUntil == 0` means indefinite — intentional or footgun?
- Can a UserOp re-use a signature across paymasters or chains? The hash must bind both.

### Proxy / upgradeability
- Is `_authorizeUpgrade` (if present) restricted to the hub owner or a multi-sig?
- Is the implementation contract's initializer disabled in its constructor?
- Does the CREATE2 factory handle pre-existing deployments correctly (idempotent, returns the existing address)?

### Reentrancy and low-level calls
- Does `_call` (or whatever the low-level execution helper is) propagate reverts correctly without swallowing them?
- Are there reentrancy risks in `execute` / `executeBatch` (e.g. balance-affecting external calls before state writes)?
- USDC tokens are non-rebasing and don't have hooks, but if the codebase ever calls back into the same contract from a sub-call, flag it.

### Integer overflow / underflow
- Solidity 0.8+ checks by default — confirm no `unchecked` blocks exist in critical paths (signature validation, fund accounting, expiry math).
- Are `uint48` timestamps handled without truncation (no implicit narrowing from `block.timestamp`)?

### Witness rebuild path (SessionKeyValidator)
This is the highest-risk surface — added 2026-05-12 when on-chain EIP-3009 enforcement landed. Re-verify carefully:
- Are the witness fields (`to`, `value`, `validAfter`, `validBefore`, `nonce`) extracted from the signature blob in the same order and with the same encoding as the off-chain signer uses?
- Is the rebuilt `EIP-3009 TransferWithAuthorization` digest constructed against the correct USDC domain (`name="USD Coin"`, `version="2"`, `chainId`, `verifyingContract` = USDC address)?
- Is the rebuilt digest compared with `==` against the wrapped 1271 hash, with a clear revert on mismatch?
- Could a malicious witness produce a digest that matches a *different* legitimate signature? (Replay across recipients, amounts, or time windows.)

### Storage layout
- For upgradeable contracts: any new variable added at the end of the storage layout? Mid-storage insertions are CRITICAL.
- Per-Kernel storage in the validator: keyed correctly by `address(kernel)` not by `msg.sender` when intent is to scope to the calling Kernel?

## Step 4 — report

Produce a structured summary:

- **Test results:** counts from Steps 1 and 2.
- **Findings:** every issue from Step 3, categorized CRITICAL / HIGH / MEDIUM / LOW / INFO with file:line.
- **Recommendations:** specific code changes for each non-INFO finding.
- **Status:** **PASS** (no CRITICAL / HIGH issues) or **FAIL** (action required before merge / deploy).

If the audit passes, state explicitly: "contracts ready for the next deployment step." If issues are found, list exactly what needs to change and in which file.

Do **not** modify any source files during this audit — read-only review. Any changes go in a separate PR after triage.
