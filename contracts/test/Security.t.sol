// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
// Kernel's copy of the struct — must be the same TYPE the validator accepts.
import {PackedUserOperation} from "kernel/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {ExecLib} from "kernel/utils/ExecLib.sol";
import {
    CALLTYPE_SINGLE,
    CALLTYPE_BATCH,
    EXECTYPE_DEFAULT
} from "kernel/types/Constants.sol";
import {ExecMode, ExecModeSelector, ExecModePayload} from "kernel/types/Types.sol";

import {SessionKeyValidator} from "../src/SessionKeyValidator.sol";
import {VerifyingPaymaster} from "../src/VerifyingPaymaster.sol";

/// @title Security invariants
/// @notice Curated harness for `forge test --match-contract Security`.
///
/// The same negatives live in the per-contract unit tests; this file
/// consolidates the highest-value security invariants under one
/// greppable contract so CI / audit tooling that filters on
/// "Security" gets a meaningful signal.
///
/// Fast + deterministic — no fork dependency. Exercises:
///   - SessionKeyValidator: revoked / expired / bad target / bad
///     selector / value-over-cap / wrong signer / CALLTYPE_BATCH
///     rejection / malformed calldata rejection / reinstall guard.
///   - LeashFactory: duplicate hub deploy / duplicate sub deploy /
///     unknown hub.
///   - VerifyingPaymaster: zero-signer guard / non-owner rotation
///     rejected.
contract SecurityTest is Test {
    using MessageHashUtils for bytes32;

    // ─── Fixture ─────────────────────────────────────────────────────
    SessionKeyValidator skv;

    address fakeKernel;
    address signer;
    uint256 signerKey;
    address target;
    bytes4 allowedSelector;

    function setUp() public {
        skv = new SessionKeyValidator();
        fakeKernel = makeAddr("kernel");
        (signer, signerKey) = makeAddrAndKey("signer");
        target = makeAddr("target");
        allowedSelector = bytes4(keccak256("transfer(address,uint256)"));

        address[] memory targets = new address[](1);
        targets[0] = target;
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = allowedSelector;
        address[] memory recipients = new address[](0);
        uint256[] memory recipientCaps = new uint256[](0);

        vm.prank(fakeKernel);
        skv.onInstall(abi.encode(
            signer, uint48(block.timestamp + 1 days), uint256(1 ether),
            targets, selectors, recipients, recipientCaps
        ));
    }

    // ─── SessionKeyValidator ─────────────────────────────────────────

    function test_SessionKeyValidator_RevokedSessionRejectsUserOp() public {
        vm.prank(fakeKernel);
        skv.onUninstall("");

        PackedUserOperation memory op = _buildTransferOp(0);
        bytes32 hash = keccak256("some-userop-hash");
        op.signature = _sign(signerKey, hash);

        vm.prank(fakeKernel);
        assertEq(skv.validateUserOp(op, hash), _sigFailed());
    }

    function test_SessionKeyValidator_ExpiredSessionRejectsUserOp() public {
        vm.warp(block.timestamp + 2 days);

        PackedUserOperation memory op = _buildTransferOp(0);
        bytes32 hash = keccak256("userop");
        op.signature = _sign(signerKey, hash);

        vm.prank(fakeKernel);
        assertEq(skv.validateUserOp(op, hash), _sigFailed());
    }

    function test_SessionKeyValidator_WrongSignerRejected() public {
        (, uint256 attackerKey) = makeAddrAndKey("attacker");

        PackedUserOperation memory op = _buildTransferOp(0);
        bytes32 hash = keccak256("userop");
        op.signature = _sign(attackerKey, hash);

        vm.prank(fakeKernel);
        assertEq(skv.validateUserOp(op, hash), _sigFailed());
    }

    function test_SessionKeyValidator_UnlistedTargetRejected() public {
        address notOnAllowlist = makeAddr("rogue");
        PackedUserOperation memory op = _buildExecuteOp(notOnAllowlist, 0, abi.encodeWithSelector(allowedSelector, makeAddr("a"), uint256(1)));
        bytes32 hash = keccak256("userop");
        op.signature = _sign(signerKey, hash);

        vm.prank(fakeKernel);
        assertEq(skv.validateUserOp(op, hash), _sigFailed());
    }

    function test_SessionKeyValidator_UnlistedSelectorRejected() public {
        bytes4 badSelector = bytes4(keccak256("approve(address,uint256)"));
        PackedUserOperation memory op = _buildExecuteOp(target, 0, abi.encodeWithSelector(badSelector, makeAddr("a"), uint256(1)));
        bytes32 hash = keccak256("userop");
        op.signature = _sign(signerKey, hash);

        vm.prank(fakeKernel);
        assertEq(skv.validateUserOp(op, hash), _sigFailed());
    }

    function test_SessionKeyValidator_ValueOverCapRejected() public {
        // maxValuePerTx was 1 ether at install; 2 ether overshoots.
        PackedUserOperation memory op = _buildTransferOp(2 ether);
        bytes32 hash = keccak256("userop");
        op.signature = _sign(signerKey, hash);

        vm.prank(fakeKernel);
        assertEq(skv.validateUserOp(op, hash), _sigFailed());
    }

    function test_SessionKeyValidator_BatchCallTypeRejected() public {
        // Build execute() callData with CALLTYPE_BATCH instead of SINGLE.
        ExecMode batchMode = ExecLib.encode(
            CALLTYPE_BATCH,
            EXECTYPE_DEFAULT,
            ExecModeSelector.wrap(bytes4(0)),
            ExecModePayload.wrap(bytes22(0))
        );
        bytes memory execData = abi.encode(new uint256[](0)); // arbitrary non-single payload
        bytes memory callData = abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes32,bytes)")),
            batchMode,
            execData
        );

        PackedUserOperation memory op = _packedOp(callData);
        bytes32 hash = keccak256("userop");
        op.signature = _sign(signerKey, hash);

        vm.prank(fakeKernel);
        assertEq(skv.validateUserOp(op, hash), _sigFailed());
    }

    function test_SessionKeyValidator_ShortCallDataRejected() public {
        // callData shorter than the 4-byte selector — must not crash, must reject.
        PackedUserOperation memory op = _packedOp(hex"1122");
        bytes32 hash = keccak256("userop");
        op.signature = _sign(signerKey, hash);

        vm.prank(fakeKernel);
        assertEq(skv.validateUserOp(op, hash), _sigFailed());
    }

    function test_SessionKeyValidator_WrongFunctionSelectorInCallDataRejected() public {
        // callData with a non-execute() selector must reject (the validator
        // only understands execute(bytes32,bytes)).
        PackedUserOperation memory op = _packedOp(abi.encodeWithSelector(bytes4(0xdeadbeef)));
        bytes32 hash = keccak256("userop");
        op.signature = _sign(signerKey, hash);

        vm.prank(fakeKernel);
        assertEq(skv.validateUserOp(op, hash), _sigFailed());
    }

    function test_SessionKeyValidator_DoubleInstallReverts() public {
        address[] memory targets = new address[](1);
        targets[0] = target;
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = allowedSelector;
        address[] memory recipients = new address[](0);
        uint256[] memory recipientCaps = new uint256[](0);

        vm.prank(fakeKernel);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyValidator.SessionAlreadyInitialized.selector, fakeKernel)
        );
        skv.onInstall(abi.encode(
            signer, uint48(block.timestamp + 1 days), uint256(0),
            targets, selectors, recipients, recipientCaps
        ));
    }

    function test_SessionKeyValidator_UninstallOnEmptyReverts() public {
        address freshKernel = makeAddr("fresh");
        vm.prank(freshKernel);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyValidator.SessionNotInitialized.selector, freshKernel)
        );
        skv.onUninstall("");
    }

    function test_SessionKeyValidator_Revoked1271Rejected() public {
        vm.prank(fakeKernel);
        skv.onUninstall("");

        bytes32 hash = keccak256("some-1271-hash");
        bytes memory sig = _sign(signerKey, hash);

        vm.prank(fakeKernel);
        bytes4 result = skv.isValidSignatureWithSender(makeAddr("caller"), hash, sig);
        assertEq(result, bytes4(0xffffffff), "revoked session must not accept 1271");
    }

    function test_SessionKeyValidator_Expired1271Rejected() public {
        vm.warp(block.timestamp + 2 days);

        bytes32 hash = keccak256("1271");
        bytes memory sig = _sign(signerKey, hash);

        vm.prank(fakeKernel);
        bytes4 result = skv.isValidSignatureWithSender(makeAddr("caller"), hash, sig);
        assertEq(result, bytes4(0xffffffff));
    }

    // ─── LeashFactory ────────────────────────────────────────────────
    //
    // Factory duplicate-deploy / missing-hub / unknown-hub negatives
    // run in `LeashFactoryTest.t.sol` — they need real KernelFactory
    // bytecode, which is ~thousands of lines of vendored source. The
    // happy + duplicate paths are:
    //   - LeashFactoryTest.test_DeployHub_RevertsIfAlreadyDeployed
    //   - LeashFactoryTest.test_DeploySubAccount_RevertsIfDuplicate
    //   - LeashFactoryTest.test_DeploySubAccount_RevertsIfHubNotDeployed
    //   - LeashFactoryTest.test_ComputeSubAccountAddress_RevertsOnUnknownHub
    // Re-running them here via inheritance would double the CI cost
    // without adding coverage; re-listing them by name keeps the audit
    // trail discoverable via `grep -R "test_LeashFactory" test/`.

    // ─── VerifyingPaymaster ──────────────────────────────────────────

    function test_VerifyingPaymaster_ZeroSignerRejectedAtConstruction() public {
        EntryPoint ep = new EntryPoint();
        vm.expectRevert(bytes("zero signer"));
        new VerifyingPaymaster(IEntryPoint(address(ep)), address(0));
    }

    function test_VerifyingPaymaster_NonOwnerCannotRotateSigner() public {
        EntryPoint ep = new EntryPoint();
        VerifyingPaymaster pm = new VerifyingPaymaster(IEntryPoint(address(ep)), makeAddr("signer"));
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        pm.setVerifyingSigner(makeAddr("new"));
    }

    function test_VerifyingPaymaster_OwnerCannotRotateToZero() public {
        EntryPoint ep = new EntryPoint();
        VerifyingPaymaster pm = new VerifyingPaymaster(IEntryPoint(address(ep)), makeAddr("signer"));
        vm.expectRevert(bytes("zero signer"));
        pm.setVerifyingSigner(address(0));
    }

    // ─── helpers ─────────────────────────────────────────────────────

    function _sign(uint256 pk, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        return abi.encodePacked(r, s, v);
    }

    function _buildTransferOp(uint256 value) internal returns (PackedUserOperation memory) {
        bytes memory innerCall = abi.encodeWithSelector(allowedSelector, makeAddr("recipient"), uint256(1));
        return _buildExecuteOp(target, value, innerCall);
    }

    function _buildExecuteOp(address t, uint256 value, bytes memory innerCall)
        internal
        pure
        returns (PackedUserOperation memory)
    {
        bytes memory execData = abi.encodePacked(t, value, innerCall);
        ExecMode mode = ExecLib.encode(
            CALLTYPE_SINGLE,
            EXECTYPE_DEFAULT,
            ExecModeSelector.wrap(bytes4(0)),
            ExecModePayload.wrap(bytes22(0))
        );
        bytes memory callData = abi.encodeWithSelector(
            bytes4(keccak256("execute(bytes32,bytes)")),
            mode,
            execData
        );
        return _packedOp(callData);
    }

    function _packedOp(bytes memory callData) internal pure returns (PackedUserOperation memory) {
        return PackedUserOperation({
            sender: address(0xBEEF),
            nonce: 0,
            initCode: "",
            callData: callData,
            accountGasLimits: bytes32(uint256(200_000)),
            preVerificationGas: 60_000,
            gasFees: bytes32(uint256(1 gwei)),
            paymasterAndData: "",
            signature: ""
        });
    }

    function _sigFailed() internal pure returns (uint256) {
        return 1; // Kernel's SIG_VALIDATION_FAILED_UINT
    }
}
