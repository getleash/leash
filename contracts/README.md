# Leash Contracts

Solidity for the Leash hub / sub-account / session-key stack. Targets Base mainnet via ZeroDev's Kernel v3.3 (vendored as a submodule in `lib/kernel/`).

## Contracts shipped

| Contract | Lines | Role |
| --- | --- | --- |
| `src/LeashFactory.sol` | ~140 | CREATE2 wrapper over `KernelFactory`; registry `owner → hub → subs[]`. No paymaster coupling. |
| `src/SessionKeyValidator.sol` | ~180 | ERC-7579 secondary validator. UserOp path: signer + expiry + (target, selector, msg.value) allowlist. 1271 path: signer + expiry only. |
| `src/VerifyingPaymaster.sol` | ~95 | Canonical `BasePaymaster` + ECDSA verifying signer pattern. No on-chain sender check per [`summary/paymaster-scope.md`](../summary/paymaster-scope.md). |

## Test matrix (22/22 green on Base fork, 2026-04-20)

- `LeashFactory.t.sol` — 10 tests: happy deploys (hub, multi-sub), determinism (CREATE2 predicted address matches deployed), negatives (duplicate hub, duplicate sub, deploy-sub-without-hub, unknown hub in counterfactual).
- `SessionKeyValidator.t.sol` — 10 tests: UserOp happy + 5 negatives (revoked, expired, bad target, bad selector, value > cap, wrong signer), 1271 happy via Kernel routing, 1271 revoked, 1271 expired.
- `LeashIntegration.t.sol` — 2 tests: full `EntryPoint.handleOps` round for a session-key-signed USDC transfer UserOp, and revoke via `Kernel.uninstallValidation` → next UserOp fails at validation.

## Gas budgets

| Operation | Budget | Observed | Status |
| --- | --- | --- | --- |
| Sub-account deploy (via LeashFactory) | < 500k | ~270k (standalone); 492k for hub+sub combined in one tx | ✓ |
| Transfer UserOp (session-key-signed, full handleOps) | < 200k | 160,299 | ✓ |

The transfer-UserOp gas is asserted in `LeashIntegration.t.sol::testFull_SessionKeyUserOpThroughEntryPoint`.

## Run

```bash
export BASE_RPC_URL=https://mainnet.base.org
forge test -vv
```

Forge profile: `solc 0.8.26`, `evm_version=cancun`, `via_ir=true`, optimizer 200 runs.

## Deployment

Mainnet deploy script: `script/DeployLeash.s.sol`. Deployed addresses are recorded in `packages/core/src/constants.ts`.
