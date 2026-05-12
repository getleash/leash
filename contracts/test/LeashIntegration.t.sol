// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Kernel} from "kernel/Kernel.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {IEntryPoint} from "kernel/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "kernel/interfaces/PackedUserOperation.sol";
import {ECDSAValidator} from "kernel/validator/ECDSAValidator.sol";
import {ExecLib} from "kernel/utils/ExecLib.sol";
import {
    CALLTYPE_SINGLE,
    EXECTYPE_DEFAULT,
    MODULE_TYPE_VALIDATOR
} from "kernel/types/Constants.sol";
import {ExecMode, ExecModeSelector, ExecModePayload, ValidationId} from "kernel/types/Types.sol";
import {ValidatorLib} from "kernel/utils/ValidationTypeLib.sol";

import {SessionKeyValidator} from "../src/SessionKeyValidator.sol";
import {LeashFactory} from "../src/LeashFactory.sol";

interface IUSDCv2 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// End-to-end: LeashFactory → hub + sub → install SessionKeyValidator →
/// session-key-signed USDC transfer UserOp through the real EntryPoint →
/// revoke via Kernel.uninstallValidation → next UserOp fails at validation.
contract LeashIntegrationTest is Test {
    IEntryPoint constant ENTRYPOINT_V07 = IEntryPoint(0x0000000071727De22E5E9d8BAf0edAc6f37da032);
    IUSDCv2 constant USDC = IUSDCv2(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    uint256 constant BASE_CHAIN_ID = 8453;

    bytes4 constant ERC20_TRANSFER_SELECTOR = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 constant KERNEL_EXECUTE_SELECTOR = bytes4(keccak256("execute(bytes32,bytes)"));

    Kernel kernelImpl;
    KernelFactory kernelFactory;
    ECDSAValidator rootValidator;
    LeashFactory leashFactory;
    SessionKeyValidator skValidator;

    address subAccount;
    address hubOwner;
    uint256 hubOwnerPk;
    address sessionKey;
    uint256 sessionKeyPk;
    address recipient = address(0xBEEF);
    uint48 validUntil;

    address bundler; // anyone — EntryPoint just needs a beneficiary

    function setUp() public {
        vm.createSelectFork(vm.envString("BASE_RPC_URL"));
        assertEq(block.chainid, BASE_CHAIN_ID);

        kernelImpl = new Kernel(ENTRYPOINT_V07);
        kernelFactory = new KernelFactory(address(kernelImpl));
        rootValidator = new ECDSAValidator();
        leashFactory = new LeashFactory(kernelFactory, rootValidator);
        skValidator = new SessionKeyValidator();

        (hubOwner, hubOwnerPk) = makeAddrAndKey("hubOwner");
        (sessionKey, sessionKeyPk) = makeAddrAndKey("sessionKey");
        bundler = makeAddr("bundler");
        validUntil = uint48(block.timestamp + 30 days);

        vm.prank(hubOwner);
        leashFactory.deployHub();
        vm.prank(hubOwner);
        subAccount = leashFactory.deploySubAccount("cryptonit");

        _installSessionKeyValidator();

        // Fund the sub-account's EntryPoint deposit so it can pay its own gas
        // (no paymaster in this test — paymaster integration is Phase 6).
        vm.deal(subAccount, 1 ether);
        vm.prank(subAccount);
        ENTRYPOINT_V07.depositTo{value: 0.05 ether}(subAccount);

        deal(address(USDC), subAccount, 10_000_000); // 10 USDC
    }

    /// Full UserOp flow: session key → EntryPoint → Kernel → SessionKeyValidator → execute → USDC.transfer.
    /// Also serves as the "transfer UserOp < 200k gas" acceptance check.
    function testFull_SessionKeyUserOpThroughEntryPoint() public {
        PackedUserOperation memory op = _buildTransferUserOp(recipient, 10_000);
        bytes32 userOpHash = ENTRYPOINT_V07.getUserOpHash(op);
        op.signature = _sign(sessionKeyPk, userOpHash);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;

        uint256 recipBalBefore = USDC.balanceOf(recipient);
        uint256 gasBefore = gasleft();
        ENTRYPOINT_V07.handleOps(ops, payable(bundler));
        uint256 gasUsed = gasBefore - gasleft();

        assertEq(
            USDC.balanceOf(recipient) - recipBalBefore,
            10_000,
            "transfer settled via UserOp"
        );
        emit log_named_uint("transfer UserOp gas (full handleOps round)", gasUsed);
        // Phase 3 acceptance: transfer UserOp < 200k gas.
        // Observed: ~160k — meets the budget with headroom.
        assertLt(gasUsed, 200_000, "transfer UserOp must fit 200k budget");
    }

    /// Revoke via the real Kernel.uninstallValidation path (the one the CLI
    /// will use). After uninstall, the session key can no longer sign any
    /// UserOp — EntryPoint validation rejects it.
    function testFull_RevokeViaKernelUninstall() public {
        // First run — establish the baseline that things work pre-revoke.
        PackedUserOperation memory op1 = _buildTransferUserOp(recipient, 10_000);
        bytes32 hash1 = ENTRYPOINT_V07.getUserOpHash(op1);
        op1.signature = _sign(sessionKeyPk, hash1);
        PackedUserOperation[] memory ops1 = new PackedUserOperation[](1);
        ops1[0] = op1;
        ENTRYPOINT_V07.handleOps(ops1, payable(bundler));

        // Revoke via Kernel (as hub owner).
        ValidationId skVId = ValidationId.wrap(
            bytes21(abi.encodePacked(bytes1(0x01), address(skValidator)))
        );
        vm.prank(hubOwner);
        Kernel(payable(subAccount)).uninstallValidation(skVId, bytes(""), bytes(""));

        // Try another UserOp — EntryPoint should reject at validation
        // (validator no longer registered / revoked via validNonceFrom).
        PackedUserOperation memory op2 = _buildTransferUserOp(recipient, 10_000);
        bytes32 hash2 = ENTRYPOINT_V07.getUserOpHash(op2);
        op2.signature = _sign(sessionKeyPk, hash2);
        PackedUserOperation[] memory ops2 = new PackedUserOperation[](1);
        ops2[0] = op2;
        vm.expectRevert();
        ENTRYPOINT_V07.handleOps(ops2, payable(bundler));
    }

    // --- helpers ---

    function _installSessionKeyValidator() internal {
        address[] memory targets = new address[](1);
        targets[0] = address(USDC);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = ERC20_TRANSFER_SELECTOR;

        // x402 recipient allowlist isn't exercised in the UserOp-only tests below,
        // but the validator requires the install data to include the recipient
        // arrays. Install a single recipient so onInstall accepts the data.
        address[] memory recipients = new address[](1);
        recipients[0] = recipient;
        uint256[] memory recipientCaps = new uint256[](1);
        recipientCaps[0] = 1_000_000; // 1.00 USDC

        bytes memory validatorData = abi.encode(
            sessionKey, validUntil, uint256(0), targets, selectors, recipients, recipientCaps
        );
        bytes memory installFormat =
            abi.encode(validatorData, bytes(""), abi.encodePacked(KERNEL_EXECUTE_SELECTOR));
        bytes memory initData = abi.encodePacked(bytes20(uint160(0)), installFormat);

        vm.prank(hubOwner);
        Kernel(payable(subAccount)).installModule(MODULE_TYPE_VALIDATOR, address(skValidator), initData);
    }

    function _buildTransferUserOp(address to, uint256 amount)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        bytes memory innerCall = abi.encodeWithSelector(ERC20_TRANSFER_SELECTOR, to, amount);
        bytes memory execData = abi.encodePacked(address(USDC), uint256(0), innerCall);
        ExecMode mode = ExecLib.encode(
            CALLTYPE_SINGLE, EXECTYPE_DEFAULT, ExecModeSelector.wrap(bytes4(0)), ExecModePayload.wrap(bytes22(0))
        );
        bytes memory callData = abi.encodeWithSelector(KERNEL_EXECUTE_SELECTOR, mode, execData);

        // Each test gets a fresh nonceKey so the EntryPoint seq doesn't collide
        // across testFull_RevokeViaKernelUninstall's two ops.
        uint64 seq = uint64(ENTRYPOINT_V07.getNonce(subAccount, _nonceKey()));
        uint256 nonce = ValidatorLib.encodeAsNonce(
            bytes1(0x00), bytes1(0x01), bytes20(address(skValidator)), _nonceKey16(), seq
        );

        op = PackedUserOperation({
            sender: subAccount,
            nonce: nonce,
            initCode: bytes(""),
            callData: callData,
            accountGasLimits: bytes32((uint256(300_000) << 128) | uint256(200_000)),
            preVerificationGas: 60_000,
            gasFees: bytes32((uint256(1 gwei) << 128) | uint256(1 gwei)),
            paymasterAndData: bytes(""),
            signature: bytes("")
        });
    }

    /// Derive the 192-bit nonce key from the encoded (mode, type, validator, nonceKey16).
    /// EntryPoint uses it to look up the current sequence number.
    function _nonceKey() internal view returns (uint192) {
        return ValidatorLib.encodeAsNonceKey(
            bytes1(0x00), bytes1(0x01), bytes20(address(skValidator)), _nonceKey16()
        );
    }

    function _nonceKey16() internal pure returns (uint16) {
        return 0;
    }

    function _sign(uint256 pk, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }
}
