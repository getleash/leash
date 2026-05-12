// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {VerifyingPaymaster} from "../src/VerifyingPaymaster.sol";

/// Unit tests for the VerifyingPaymaster's validation path.
///
/// Non-fork — we don't need a real EntryPoint. BasePaymaster only
/// stores the entrypoint address in the constructor and gates
/// `validatePaymasterUserOp` behind `msg.sender == entrypoint`.
/// We vm.prank as a placeholder EntryPoint to exercise the path
/// directly. Tests cover: hash determinism + chain binding, valid
/// signature → no sigFailed flag, invalid signature → sigFailed,
/// expired / pre-validAfter → surfaced in validationData for EntryPoint
/// to reject, malformed paymasterData length → revert, onlyOwner +
/// zero-address guards on setVerifyingSigner.
contract VerifyingPaymasterTest is Test {
    using MessageHashUtils for bytes32;

    VerifyingPaymaster paymaster;

    IEntryPoint entryPointContract;
    address entryPoint;
    address signer;
    uint256 signerKey;
    address notSigner;
    uint256 notSignerKey;
    address sender;

    function setUp() public {
        // Deploy a real EntryPoint — BasePaymaster's constructor calls
        // supportsInterface on it and reverts if the interface doesn't
        // match. Cheap enough to deploy inline in setUp (~1ms).
        entryPointContract = IEntryPoint(address(new EntryPoint()));
        entryPoint = address(entryPointContract);
        (signer, signerKey) = makeAddrAndKey("signer");
        (notSigner, notSignerKey) = makeAddrAndKey("notSigner");
        sender = makeAddr("sender");
        paymaster = new VerifyingPaymaster(entryPointContract, signer);
    }

    // ─── getHash ─────────────────────────────────────────────────────

    function test_GetHash_Deterministic() public view {
        PackedUserOperation memory op = _unsignedOp();
        bytes32 h1 = paymaster.getHash(op, uint48(2_000_000_000), uint48(0));
        bytes32 h2 = paymaster.getHash(op, uint48(2_000_000_000), uint48(0));
        assertEq(h1, h2, "same inputs must produce same hash");
    }

    function test_GetHash_ChainBound() public {
        PackedUserOperation memory op = _unsignedOp();
        bytes32 h1 = paymaster.getHash(op, uint48(2_000_000_000), uint48(0));
        vm.chainId(99);
        bytes32 h2 = paymaster.getHash(op, uint48(2_000_000_000), uint48(0));
        assertTrue(h1 != h2, "chainid change must alter hash");
    }

    function test_GetHash_PaymasterAddressBound() public {
        PackedUserOperation memory op = _unsignedOp();
        bytes32 h1 = paymaster.getHash(op, uint48(2_000_000_000), uint48(0));

        VerifyingPaymaster other = new VerifyingPaymaster(entryPointContract, signer);
        bytes32 h2 = other.getHash(op, uint48(2_000_000_000), uint48(0));
        assertTrue(h1 != h2, "paymaster address must be part of the hash");
    }

    // ─── validatePaymasterUserOp — happy path ───────────────────────

    function test_ValidSignature_NoSigFailed() public {
        uint48 validUntil = uint48(block.timestamp + 3600);
        uint48 validAfter = uint48(0);

        PackedUserOperation memory op = _unsignedOp();
        op.paymasterAndData = _packPaymasterAndData(validUntil, validAfter, _signForPaymaster(op, validUntil, validAfter, signerKey));

        vm.prank(entryPoint);
        (bytes memory ctx, uint256 validationData) =
            paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertEq(ctx.length, 0, "context must be empty");
        assertFalse(_sigFailed(validationData), "valid sig must not set sigFailed bit");
        // Time bounds round-trip.
        (uint48 dataValidUntil, uint48 dataValidAfter) = _unpackValidationTime(validationData);
        assertEq(dataValidUntil, validUntil);
        assertEq(dataValidAfter, validAfter);
    }

    // ─── validatePaymasterUserOp — failure modes ────────────────────

    function test_WrongSignerReturnsSigFailed() public {
        uint48 validUntil = uint48(block.timestamp + 3600);
        uint48 validAfter = uint48(0);

        PackedUserOperation memory op = _unsignedOp();
        op.paymasterAndData = _packPaymasterAndData(validUntil, validAfter, _signForPaymaster(op, validUntil, validAfter, notSignerKey));

        vm.prank(entryPoint);
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertTrue(_sigFailed(validationData), "wrong signer must set sigFailed bit");
    }

    function test_TamperedOpReturnsSigFailed() public {
        // Sign one nonce, submit a different one. EntryPoint would reject,
        // but the paymaster must flag it first so aggregators see a failed sig.
        uint48 validUntil = uint48(block.timestamp + 3600);
        uint48 validAfter = uint48(0);

        PackedUserOperation memory op = _unsignedOp();
        bytes memory sig = _signForPaymaster(op, validUntil, validAfter, signerKey);
        op.nonce = 42; // tamper AFTER signing
        op.paymasterAndData = _packPaymasterAndData(validUntil, validAfter, sig);

        vm.prank(entryPoint);
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertTrue(_sigFailed(validationData), "tampered op must set sigFailed bit");
    }

    function test_ExpiredValidUntilSurfacedInValidationData() public {
        // Past validUntil. Paymaster still returns the bounds in
        // validationData; EntryPoint then rejects. Here we only assert
        // the bounds land where EntryPoint expects them.
        uint48 validUntil = uint48(block.timestamp - 1);
        uint48 validAfter = uint48(0);

        PackedUserOperation memory op = _unsignedOp();
        op.paymasterAndData = _packPaymasterAndData(validUntil, validAfter, _signForPaymaster(op, validUntil, validAfter, signerKey));

        vm.prank(entryPoint);
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertFalse(_sigFailed(validationData), "expired bounds still signable; EntryPoint gates on time");
        (uint48 dataValidUntil, uint48 dataValidAfter) = _unpackValidationTime(validationData);
        assertEq(dataValidUntil, validUntil, "expired validUntil surfaced");
        assertEq(dataValidAfter, validAfter);
    }

    function test_FutureValidAfterSurfacedInValidationData() public {
        uint48 validUntil = uint48(block.timestamp + 7200);
        uint48 validAfter = uint48(block.timestamp + 3600);

        PackedUserOperation memory op = _unsignedOp();
        op.paymasterAndData = _packPaymasterAndData(validUntil, validAfter, _signForPaymaster(op, validUntil, validAfter, signerKey));

        vm.prank(entryPoint);
        (, uint256 validationData) = paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
        assertFalse(_sigFailed(validationData));
        (, uint48 dataValidAfter) = _unpackValidationTime(validationData);
        assertEq(dataValidAfter, validAfter, "future validAfter surfaced");
    }

    function test_MalformedPaymasterDataLengthReverts() public {
        PackedUserOperation memory op = _unsignedOp();
        // 76 bytes (short by 1) — should revert with "invalid paymaster data length"
        op.paymasterAndData = abi.encodePacked(
            address(paymaster),
            uint128(100_000),     // paymasterVerificationGasLimit
            uint128(50_000),      // paymasterPostOpGasLimit
            new bytes(76)         // one byte too short
        );
        vm.prank(entryPoint);
        vm.expectRevert(bytes("invalid paymaster data length"));
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function test_MalformedPaymasterDataTooLongReverts() public {
        PackedUserOperation memory op = _unsignedOp();
        op.paymasterAndData = abi.encodePacked(
            address(paymaster),
            uint128(100_000),
            uint128(50_000),
            new bytes(78)
        );
        vm.prank(entryPoint);
        vm.expectRevert(bytes("invalid paymaster data length"));
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    function test_OnlyEntryPointCanValidate() public {
        PackedUserOperation memory op = _unsignedOp();
        op.paymasterAndData = _packPaymasterAndData(uint48(block.timestamp + 3600), uint48(0), new bytes(65));
        vm.prank(makeAddr("randomCaller"));
        vm.expectRevert(); // BasePaymaster's onlyEntryPoint
        paymaster.validatePaymasterUserOp(op, bytes32(0), 0);
    }

    // ─── setVerifyingSigner ─────────────────────────────────────────

    function test_SetVerifyingSigner_OnlyOwnerCanRotate() public {
        address owner = paymaster.owner();
        vm.prank(owner);
        paymaster.setVerifyingSigner(notSigner);
        assertEq(paymaster.verifyingSigner(), notSigner);
    }

    function test_SetVerifyingSigner_RejectsNonOwner() public {
        vm.prank(makeAddr("randomCaller"));
        vm.expectRevert(); // Ownable: caller is not the owner
        paymaster.setVerifyingSigner(notSigner);
    }

    function test_SetVerifyingSigner_RejectsZero() public {
        address owner = paymaster.owner();
        vm.prank(owner);
        vm.expectRevert(bytes("zero signer"));
        paymaster.setVerifyingSigner(address(0));
    }

    function test_Constructor_RejectsZeroSigner() public {
        vm.expectRevert(bytes("zero signer"));
        new VerifyingPaymaster(entryPointContract, address(0));
    }

    // ─── helpers ────────────────────────────────────────────────────

    function _unsignedOp() internal view returns (PackedUserOperation memory op) {
        // paymasterAndData MUST be at least PAYMASTER_DATA_OFFSET (52) bytes
        // because getHash slices [:52] for the header. Pre-populate the
        // header + a 77-byte placeholder trailer; tests that need a real
        // signature overwrite the whole field via _packPaymasterAndData.
        op = PackedUserOperation({
            sender: sender,
            nonce: 1,
            initCode: "",
            callData: "",
            accountGasLimits: bytes32((uint256(300_000) << 128) | uint256(200_000)),
            preVerificationGas: 60_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: abi.encodePacked(
                address(paymaster),
                uint128(100_000),
                uint128(50_000),
                new bytes(77)
            ),
            signature: ""
        });
    }

    function _signForPaymaster(
        PackedUserOperation memory op,
        uint48 validUntil,
        uint48 validAfter,
        uint256 pk
    ) internal view returns (bytes memory) {
        // The paymaster reads paymasterAndData[:PAYMASTER_DATA_OFFSET]
        // for its getHash (addr + gas limits). Put the concrete header
        // into the op before computing the hash so the signature binds
        // to the real blob. The signature bytes themselves are NOT in
        // the hash (would be circular) — only the 52-byte header.
        op.paymasterAndData = abi.encodePacked(
            address(paymaster),
            uint128(100_000),
            uint128(50_000),
            new bytes(77) // placeholder header-sized trailer for consistent length
        );
        bytes32 hash = paymaster.getHash(op, validUntil, validAfter);
        bytes32 ethHash = hash.toEthSignedMessageHash();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _packPaymasterAndData(uint48 validUntil, uint48 validAfter, bytes memory signature)
        internal
        view
        returns (bytes memory)
    {
        require(signature.length == 65, "test helper: 65-byte sig expected");
        return abi.encodePacked(
            address(paymaster),
            uint128(100_000),       // paymasterVerificationGasLimit
            uint128(50_000),        // paymasterPostOpGasLimit
            validUntil,             // uint48, 6 bytes
            validAfter,             // uint48, 6 bytes
            signature               // 65 bytes
        );
    }

    // validationData packs: [sigFailed 160][validUntil 48][validAfter 48]
    // per EntryPoint._packValidationData. Bit 160 is the sigFailed flag
    // (0 = success, 1 = failed). The three truncating casts below are
    // deliberate — we are unpacking exactly the bits EntryPoint packed.
    function _sigFailed(uint256 validationData) internal pure returns (bool) {
        // forge-lint: disable-next-line(unsafe-typecast)
        address aggregator = address(uint160(validationData));
        return aggregator == address(1);
    }

    function _unpackValidationTime(uint256 validationData) internal pure returns (uint48 validUntil, uint48 validAfter) {
        // forge-lint: disable-next-line(unsafe-typecast)
        validUntil = uint48(validationData >> 160);
        // forge-lint: disable-next-line(unsafe-typecast)
        validAfter = uint48(validationData >> (160 + 48));
    }
}
