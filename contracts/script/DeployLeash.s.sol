// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
// Two different IEntryPoint declarations live in this build (Kernel
// has its own vendored copy, the rest of the eth-infinitism stack
// uses the canonical one). Alias to disambiguate constructor casts.
import {IEntryPoint as IEntryPointAA} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IEntryPoint as IEntryPointKernel} from "kernel/interfaces/IEntryPoint.sol";
import {Kernel} from "kernel/Kernel.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {ECDSAValidator} from "kernel/validator/ECDSAValidator.sol";

import {LeashFactory} from "../src/LeashFactory.sol";
import {SessionKeyValidator} from "../src/SessionKeyValidator.sol";
import {VerifyingPaymaster} from "../src/VerifyingPaymaster.sol";

/// @notice One-shot full-stack deploy.
///
/// ┌─ What this script is (and isn't) for ──────────────────────────┐
/// │                                                                │
/// │ Leash's production model is **singleton contracts**: every     │
/// │ user of `leash apply` points at the SAME canonical LeashFactory│
/// │ + SessionKeyValidator + VerifyingPaymaster deployed by the     │
/// │ maintainer on Base mainnet. Per-user state lives in CREATE2-   │
/// │ deployed hub/sub Kernels, not in re-deployed Leash contracts.  │
/// │                                                                │
/// │ The canonical mainnet addresses are recorded in                │
/// │ `packages/core/src/constants.ts`. `leash apply` reads them     │
/// │ from there. End-users do NOT run this script.                  │
/// │                                                                │
/// │ This script exists for three reasons only:                     │
/// │   1. Auditable transparency — the recipe that produced the     │
/// │      canonical mainnet deployment, reproducible from the       │
/// │      vendored Kernel submodule commit.                         │
/// │   2. Local dev / integration tests — deploy a private stack    │
/// │      on Sepolia or `anvil` for development without touching    │
/// │      mainnet.                                                  │
/// │   3. Forking — someone wants a Leash-shaped stack under a      │
/// │      different brand or on a different chain.                  │
/// │                                                                │
/// │ ⚠️ This script broadcasts whatever you point `--rpc-url` at.   │
/// │   Pointing at mainnet deploys real contracts and burns real    │
/// │   ETH (~$30–80 at typical gas prices for the full six-step    │
/// │   stack). Default to a testnet (`--rpc-url $SEPOLIA_RPC`) for │
/// │   local dev. There is no testnet-only safety check in this    │
/// │   script — the responsibility is on the caller.                │
/// └────────────────────────────────────────────────────────────────┘
///
/// Deploys, in this order:
///   1. Kernel implementation                (vendored from contracts/lib/kernel)
///   2. KernelFactory(kernelImpl)
///   3. ECDSAValidator
///   4. LeashFactory(kernelFactory, ecdsaValidator)
///   5. SessionKeyValidator
///   6. VerifyingPaymaster(EntryPoint, verifyingSigner)
///
/// Steps 1–3 can be skipped via env overrides if the chain has a
/// pre-existing deployment you trust. Default behavior is to deploy
/// everything fresh — keeps the Leash stack reproducible from the
/// vendored submodule commit, and avoids inheriting one-off PoC
/// deploys whose ABIs may not match the canonical sources.
///
/// Run:
///   forge script contracts/script/DeployLeash.s.sol:DeployLeash \
///       --rpc-url $LEASH_BASE_RPC \
///       --chain base \
///       --broadcast \
///       --verify
///
/// RPC consistency caveat (load-balanced public endpoints):
///   After this script's broadcast returns, downstream tooling (e.g. the
///   CLI's `apply` flow, or any script that calls `sync-deployments` then
///   immediately reads contract state) may observe zeroed reads for **3–5
///   seconds** before all RPC nodes catch up. The public endpoint at
///   `https://mainnet.base.org` is the worst offender; a dedicated RPC
///   (Alchemy, QuickNode) usually removes the lag entirely.
///
///   In practice this matters most for `installModule` on a freshly-
///   deployed Kernel — see `packages/cli/src/commands/apply.ts` for the
///   sleep-then-verify pattern. If you script around this deploy, add a
///   5-second sleep before any post-broadcast state assertion, or wrap
///   the read in a retry transport (`viem`'s `http(url, { retryCount,
///   retryDelay })`).
///
/// Env (required):
///   DEPLOYER_PRIVATE_KEY         — pays gas for all six deploys
///   PAYMASTER_SIGNER_ADDRESS     — sets VerifyingPaymaster.verifyingSigner
///                                   (per paymaster-scope.md: the hub-owner EOA)
///
/// Env (optional — only set if you want to reuse an existing deploy
/// of the upstream ZeroDev contracts; otherwise we deploy them fresh):
///   KERNEL_FACTORY              — KernelFactory address. If set, KERNEL_IMPL
///                                  must also be set OR the factory must
///                                  already exist on chain. Skips steps 1+2.
///   KERNEL_IMPL                 — Kernel implementation address. Reported
///                                  in output for `sync-deployments` to
///                                  pick up; not used in code.
///   ECDSA_VALIDATOR             — ECDSAValidator address. If set, skips step 3.
///   PAYMASTER_DEPOSIT_WEI       — wei to pre-deposit on EntryPoint
///                                  (default: 0 — operator tops up after deploy)
///   PAYMASTER_STAKE_WEI         — wei to stake on EntryPoint
///                                  (default: 0 — stake is optional per PoC-D)
///
/// Output: structured `KEY=0x…` log lines that
/// scripts/sync-deployments.ts parses.
contract DeployLeash is Script {
    address constant ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifyingSigner = vm.envAddress("PAYMASTER_SIGNER_ADDRESS");

        // Reuse-or-deploy flags. Zero address sentinel = "deploy fresh".
        address envKernelFactory = vm.envOr("KERNEL_FACTORY", address(0));
        address envKernelImpl = vm.envOr("KERNEL_IMPL", address(0));
        address envEcdsaValidator = vm.envOr("ECDSA_VALIDATOR", address(0));

        uint256 paymasterDeposit = vm.envOr("PAYMASTER_DEPOSIT_WEI", uint256(0));
        uint256 paymasterStake = vm.envOr("PAYMASTER_STAKE_WEI", uint256(0));

        vm.startBroadcast(deployerKey);

        // ── 1+2. Kernel implementation + KernelFactory ───────────
        Kernel kernelImpl;
        KernelFactory kernelFactory;
        if (envKernelFactory != address(0)) {
            kernelFactory = KernelFactory(envKernelFactory);
            // KERNEL_IMPL is informational only when reusing — record
            // whatever the operator passed (or 0 if unspecified) so the
            // sync script can decide what to write.
            kernelImpl = Kernel(payable(envKernelImpl));
        } else {
            kernelImpl = new Kernel(IEntryPointKernel(ENTRYPOINT_V07));
            kernelFactory = new KernelFactory(address(kernelImpl));
        }

        // ── 3. ECDSAValidator ─────────────────────────────────────
        ECDSAValidator ecdsaValidator;
        if (envEcdsaValidator != address(0)) {
            ecdsaValidator = ECDSAValidator(envEcdsaValidator);
        } else {
            ecdsaValidator = new ECDSAValidator();
        }

        // ── 4. LeashFactory ───────────────────────────────────────
        LeashFactory leashFactory = new LeashFactory(
            kernelFactory,
            ecdsaValidator
        );

        // ── 5. SessionKeyValidator ────────────────────────────────
        SessionKeyValidator sessionKeyValidator = new SessionKeyValidator();

        // ── 6. VerifyingPaymaster ─────────────────────────────────
        VerifyingPaymaster paymaster = new VerifyingPaymaster(
            IEntryPointAA(ENTRYPOINT_V07),
            verifyingSigner
        );

        if (paymasterDeposit > 0) {
            paymaster.deposit{value: paymasterDeposit}();
        }
        if (paymasterStake > 0) {
            paymaster.addStake{value: paymasterStake}(86400); // 1 day unstake delay
        }

        vm.stopBroadcast();

        // Structured output — do NOT change the `KEY=0x…` format; the
        // sync script parses it. Six addresses always logged; for the
        // upstream ZeroDev contracts the value is either freshly
        // deployed or the env-supplied override.
        console.log("KERNEL_IMPL=%s", address(kernelImpl));
        console.log("KERNEL_FACTORY=%s", address(kernelFactory));
        console.log("ECDSA_VALIDATOR=%s", address(ecdsaValidator));
        console.log("LEASH_FACTORY=%s", address(leashFactory));
        console.log("LEASH_SESSION_KEY_VALIDATOR=%s", address(sessionKeyValidator));
        console.log("LEASH_VERIFYING_PAYMASTER=%s", address(paymaster));
        console.log("PAYMASTER_VERIFYING_SIGNER=%s", verifyingSigner);
        console.log("PAYMASTER_DEPOSIT_WEI=%s", paymasterDeposit);
        console.log("PAYMASTER_STAKE_WEI=%s", paymasterStake);
    }
}
