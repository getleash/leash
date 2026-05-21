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
    MODULE_TYPE_VALIDATOR,
    SIG_VALIDATION_SUCCESS_UINT,
    SIG_VALIDATION_FAILED_UINT,
    ERC1271_INVALID,
    ERC1271_MAGICVALUE
} from "kernel/types/Constants.sol";
import {ExecMode, ExecModeSelector, ExecModePayload} from "kernel/types/Types.sol";
import {ValidatorLib} from "kernel/utils/ValidationTypeLib.sol";

import {SessionKeyValidator} from "../src/SessionKeyValidator.sol";
import {LeashFactory} from "../src/LeashFactory.sol";

interface IUSDCv2 {
    function balanceOf(address) external view returns (uint256);
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

/// Production SessionKeyValidator tests. Covers both:
///   - UserOp path (signer, expiry, target/selector/value allowlist) — unchanged from v1.
///   - 1271 path with witness-bearing signatures and per-recipient cap enforcement
///     (the v2 design from `summary/eip3009-policy-enforcement.md`).
///
/// Sub-account is deployed via LeashFactory (registry + CREATE2 determinism)
/// so the test exercises the same install path the CLI uses.
contract SessionKeyValidatorTest is Test {
    IEntryPoint constant ENTRYPOINT_V07 = IEntryPoint(0x0000000071727De22E5E9d8BAf0edAc6f37da032);
    IUSDCv2 constant USDC = IUSDCv2(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    uint256 constant BASE_CHAIN_ID = 8453;

    bytes32 constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant KERNEL_WRAPPER_TYPE_HASH =
        0x1547321c374afde8a591d972a084b071c594c275e36724931ff96c25f2999c83;

    bytes4 constant ERC20_TRANSFER_SELECTOR = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 constant ERC20_APPROVE_SELECTOR = bytes4(keccak256("approve(address,uint256)"));
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

    // Canonical happy-path recipient; cap covers the legacy 10_000 (0.01 USDC) cases.
    address recipient = address(0xBEEF);
    uint256 recipientCap = 100_000; // 0.10 USDC

    // Cap-variance recipients exercise the per-recipient cap mapping with materially
    // different per-call costs (cheap upstream vs. premium upstream).
    address recipientCheap = address(0xC4EAB);
    address recipientPremium = address(0x9ee47101);
    uint256 cheapCap = 10_000;       // 0.01 USDC
    uint256 premiumCap = 1_000_000;  // 1.00 USDC

    uint48 validUntil;

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
        validUntil = uint48(block.timestamp + 30 days);

        vm.prank(hubOwner);
        leashFactory.deployHub();
        vm.prank(hubOwner);
        subAccount = leashFactory.deploySubAccount("cryptonit");

        _installSessionKeyValidator();
        vm.deal(subAccount, 1 ether);
        deal(address(USDC), subAccount, 10_000_000); // 10 USDC
    }

    // ============================================================
    // UserOp path — unchanged from v1
    // ============================================================

    function testUnit_ValidateUserOp_Happy() public {
        PackedUserOperation memory op = _buildTransferUserOp(recipient, 10_000);
        bytes32 h = keccak256("h-happy");
        op.signature = _sign(sessionKeyPk, h);
        vm.prank(subAccount);
        assertEq(skValidator.validateUserOp(op, h), SIG_VALIDATION_SUCCESS_UINT);
    }

    function testUnit_ValidateUserOp_Revoked() public {
        PackedUserOperation memory op = _buildTransferUserOp(recipient, 10_000);
        bytes32 h = keccak256("h-revoked");
        op.signature = _sign(sessionKeyPk, h);
        vm.prank(subAccount);
        skValidator.onUninstall("");
        vm.prank(subAccount);
        assertEq(skValidator.validateUserOp(op, h), SIG_VALIDATION_FAILED_UINT);
    }

    function testUnit_ValidateUserOp_Expired() public {
        vm.warp(block.timestamp + 31 days);
        PackedUserOperation memory op = _buildTransferUserOp(recipient, 10_000);
        bytes32 h = keccak256("h-expired");
        op.signature = _sign(sessionKeyPk, h);
        vm.prank(subAccount);
        assertEq(skValidator.validateUserOp(op, h), SIG_VALIDATION_FAILED_UINT);
    }

    function testUnit_ValidateUserOp_BadTarget() public {
        bytes memory innerCall = abi.encodeWithSelector(ERC20_TRANSFER_SELECTOR, recipient, uint256(10_000));
        PackedUserOperation memory op = _buildExecuteUserOp(address(0xDEAD), 0, innerCall);
        bytes32 h = keccak256("h-bad-target");
        op.signature = _sign(sessionKeyPk, h);
        vm.prank(subAccount);
        assertEq(skValidator.validateUserOp(op, h), SIG_VALIDATION_FAILED_UINT);
    }

    function testUnit_ValidateUserOp_BadSelector() public {
        bytes memory innerCall = abi.encodeWithSelector(ERC20_APPROVE_SELECTOR, address(0xCAFE), uint256(1));
        PackedUserOperation memory op = _buildExecuteUserOp(address(USDC), 0, innerCall);
        bytes32 h = keccak256("h-bad-selector");
        op.signature = _sign(sessionKeyPk, h);
        vm.prank(subAccount);
        assertEq(skValidator.validateUserOp(op, h), SIG_VALIDATION_FAILED_UINT);
    }

    function testUnit_ValidateUserOp_ValueOverCap() public {
        bytes memory innerCall = abi.encodeWithSelector(ERC20_TRANSFER_SELECTOR, recipient, uint256(10_000));
        PackedUserOperation memory op = _buildExecuteUserOp(address(USDC), 1, innerCall); // 1 wei > cap of 0
        bytes32 h = keccak256("h-value-cap");
        op.signature = _sign(sessionKeyPk, h);
        vm.prank(subAccount);
        assertEq(skValidator.validateUserOp(op, h), SIG_VALIDATION_FAILED_UINT);
    }

    function testUnit_ValidateUserOp_WrongSigner() public {
        (, uint256 imposterPk) = makeAddrAndKey("imposter");
        PackedUserOperation memory op = _buildTransferUserOp(recipient, 10_000);
        bytes32 h = keccak256("h-wrong-signer");
        op.signature = _sign(imposterPk, h);
        vm.prank(subAccount);
        assertEq(skValidator.validateUserOp(op, h), SIG_VALIDATION_FAILED_UINT);
    }

    // ============================================================
    // 1271 integration — full path through USDC.transferWithAuthorization
    // ============================================================

    function testIntegration_1271_TransferWithAuthorization() public {
        uint256 value = 10_000; // 0.01 USDC, within recipient's 0.10 cap
        uint256 validAfter_ = block.timestamp - 60;
        uint256 validBefore_ = block.timestamp + 600;
        bytes32 nonce = keccak256("prod-1271-happy");

        bytes memory sig = _buildOuter1271Sig(recipient, value, validAfter_, validBefore_, nonce);

        uint256 recipBalBefore = USDC.balanceOf(recipient);
        uint256 subBalBefore = USDC.balanceOf(subAccount);

        vm.prank(address(0xFACE));
        USDC.transferWithAuthorization(
            subAccount, recipient, value, validAfter_, validBefore_, nonce, sig
        );

        assertEq(USDC.balanceOf(recipient) - recipBalBefore, value);
        assertEq(subBalBefore - USDC.balanceOf(subAccount), value);
    }

    function testIntegration_HappyPath_PremiumRecipient() public {
        uint256 value = 500_000; // 0.50 USDC, within premium cap (1.00)
        uint256 validAfter_ = block.timestamp - 60;
        uint256 validBefore_ = block.timestamp + 600;
        bytes32 nonce = keccak256("prod-1271-premium");

        bytes memory sig = _buildOuter1271Sig(recipientPremium, value, validAfter_, validBefore_, nonce);

        uint256 recipBalBefore = USDC.balanceOf(recipientPremium);
        uint256 subBalBefore = USDC.balanceOf(subAccount);

        vm.prank(address(0xFACE));
        USDC.transferWithAuthorization(
            subAccount, recipientPremium, value, validAfter_, validBefore_, nonce, sig
        );

        assertEq(USDC.balanceOf(recipientPremium) - recipBalBefore, value);
        assertEq(subBalBefore - USDC.balanceOf(subAccount), value);
    }

    function testIntegration_AmountOverCap_RejectsAtUSDC() public {
        // 0.05 USDC > cheap recipient's 0.01 cap
        uint256 value = 50_000;
        uint256 validAfter_ = block.timestamp - 60;
        uint256 validBefore_ = block.timestamp + 600;
        bytes32 nonce = keccak256("prod-over-cap");

        bytes memory sig = _buildOuter1271Sig(recipientCheap, value, validAfter_, validBefore_, nonce);

        vm.prank(address(0xFACE));
        vm.expectRevert(); // USDC's SignatureChecker rejects on non-magic 1271
        USDC.transferWithAuthorization(
            subAccount, recipientCheap, value, validAfter_, validBefore_, nonce, sig
        );
    }

    // ============================================================
    // 1271 unit tests — direct validator calls with witness sigs
    // ============================================================

    function testUnit_Is1271_Happy() public {
        _assert1271Valid(recipient, 10_000, "happy path");
    }

    function testUnit_Is1271_WitnessMismatch() public {
        // Sign over the digest for recipientPremium...
        uint256 value = 500_000;
        uint256 validAfter_ = block.timestamp - 60;
        uint256 validBefore_ = block.timestamp + 600;
        bytes32 nonce = keccak256("prod-witness-mismatch");
        bytes32 kernelDigest = _kernelWrap(
            _usdcTransferAuthDigest(subAccount, recipientPremium, value, validAfter_, validBefore_, nonce),
            subAccount
        );
        bytes memory innerSig = _sign(sessionKeyPk, kernelDigest);

        // ...but pack the witness for a different recipient.
        bytes memory tamperedWitness = abi.encode(recipientCheap, value, validAfter_, validBefore_, nonce);
        bytes memory sig = bytes.concat(innerSig, tamperedWitness);

        vm.prank(subAccount);
        assertEq(
            skValidator.isValidSignatureWithSender(address(USDC), kernelDigest, sig),
            ERC1271_INVALID,
            "witness tamper must fail digest equality"
        );
    }

    function testUnit_Is1271_AmountOverCap() public {
        _assert1271Invalid(recipientCheap, 50_000, "cheap above its cap");
    }

    function testUnit_Is1271_RecipientNotAllowlisted() public {
        address attacker = address(0xBADADD);
        _assert1271Invalid(attacker, 1, "attacker recipient (cap == 0)");
    }

    function testUnit_Is1271_CapVariance_CheapAtItsCap_OK() public {
        _assert1271Valid(recipientCheap, cheapCap, "cheap at its cap");
    }

    function testUnit_Is1271_CapVariance_CheapAbovePremiumCap_Rejected() public {
        // Premium recipient's cap would allow this; cheap's doesn't.
        // Confirms cheap-recipient SLOAD does NOT inherit premium's cap.
        _assert1271Invalid(recipientCheap, premiumCap, "cheap above-cap (using premium amount)");
    }

    function testUnit_Is1271_CapVariance_PremiumAtItsCap_OK() public {
        _assert1271Valid(recipientPremium, premiumCap, "premium at its cap");
    }

    function testUnit_Is1271_CapVariance_PremiumAboveItsCap_Rejected() public {
        _assert1271Invalid(recipientPremium, premiumCap + 1, "premium above its cap");
    }

    function testUnit_Is1271_Revoked() public {
        vm.prank(subAccount);
        skValidator.onUninstall("");
        _assert1271Invalid(recipient, 10_000, "revoked session");
    }

    function testUnit_Is1271_Expired() public {
        vm.warp(block.timestamp + 31 days);
        uint256 value = 10_000;
        uint256 validAfter_ = block.timestamp - 60;
        uint256 validBefore_ = block.timestamp + 60;
        bytes32 nonce = keccak256("prod-expired");
        bytes memory sig = _buildInnerWitnessSig(recipient, value, validAfter_, validBefore_, nonce);
        bytes32 kernelDigest = _kernelWrap(
            _usdcTransferAuthDigest(subAccount, recipient, value, validAfter_, validBefore_, nonce),
            subAccount
        );

        vm.prank(subAccount);
        assertEq(
            skValidator.isValidSignatureWithSender(address(USDC), kernelDigest, sig),
            ERC1271_INVALID,
            "expired session must fail 1271"
        );
    }

    function testUnit_Is1271_WrongSigner() public {
        (, uint256 imposterPk) = makeAddrAndKey("imposter");
        uint256 value = 10_000;
        uint256 validAfter_ = block.timestamp - 60;
        uint256 validBefore_ = block.timestamp + 600;
        bytes32 nonce = keccak256("prod-wrong-signer");
        bytes32 kernelDigest = _kernelWrap(
            _usdcTransferAuthDigest(subAccount, recipient, value, validAfter_, validBefore_, nonce),
            subAccount
        );
        bytes memory innerSig = _sign(imposterPk, kernelDigest);
        bytes memory witness = abi.encode(recipient, value, validAfter_, validBefore_, nonce);
        bytes memory sig = bytes.concat(innerSig, witness);

        vm.prank(subAccount);
        assertEq(
            skValidator.isValidSignatureWithSender(address(USDC), kernelDigest, sig),
            ERC1271_INVALID,
            "wrong signer must fail 1271"
        );
    }

    function testUnit_Is1271_AuthorizationOutlivesSession() public {
        // validBefore > validUntil — even with valid signer + recipient + cap,
        // the validator must reject (the auth could be replayed after revoke).
        uint256 value = 10_000;
        uint256 validAfter_ = block.timestamp - 60;
        uint256 validBefore_ = block.timestamp + 365 days; // past validUntil = 30 days
        bytes32 nonce = keccak256("prod-auth-outlives");
        bytes memory sig = _buildInnerWitnessSig(recipient, value, validAfter_, validBefore_, nonce);
        bytes32 kernelDigest = _kernelWrap(
            _usdcTransferAuthDigest(subAccount, recipient, value, validAfter_, validBefore_, nonce),
            subAccount
        );

        vm.prank(subAccount);
        assertEq(
            skValidator.isValidSignatureWithSender(address(USDC), kernelDigest, sig),
            ERC1271_INVALID,
            "auth outliving session must fail 1271"
        );
    }

    function testUnit_Is1271_ShortSignatureRejected() public {
        // Sub-MIN_SIG_LEN signatures (e.g. a bare 65-byte ECDSA without witness)
        // must reject early — guards against the witness validator silently
        // accepting legacy signing paths.
        bytes32 h = keccak256("prod-short-sig");
        bytes memory sig = _sign(sessionKeyPk, h);
        vm.prank(subAccount);
        assertEq(
            skValidator.isValidSignatureWithSender(address(0), h, sig),
            ERC1271_INVALID,
            "short signature must fail 1271"
        );
    }

    // ============================================================
    // helpers
    // ============================================================

    function _installSessionKeyValidator() internal {
        address[] memory targets = new address[](1);
        targets[0] = address(USDC);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = ERC20_TRANSFER_SELECTOR;

        address[] memory recipients = new address[](3);
        recipients[0] = recipient;
        recipients[1] = recipientCheap;
        recipients[2] = recipientPremium;
        uint256[] memory recipientCaps = new uint256[](3);
        recipientCaps[0] = recipientCap;
        recipientCaps[1] = cheapCap;
        recipientCaps[2] = premiumCap;

        bytes memory validatorData = abi.encode(
            sessionKey, validUntil, uint256(0), targets, selectors, recipients, recipientCaps
        );
        bytes memory installFormat = abi.encode(validatorData, bytes(""), abi.encodePacked(KERNEL_EXECUTE_SELECTOR));
        bytes memory initData = abi.encodePacked(bytes20(uint160(0)), installFormat);

        vm.prank(hubOwner);
        Kernel(payable(subAccount)).installModule(MODULE_TYPE_VALIDATOR, address(skValidator), initData);
    }

    function _buildTransferUserOp(address to, uint256 amount) internal view returns (PackedUserOperation memory) {
        return _buildExecuteUserOp(
            address(USDC), 0, abi.encodeWithSelector(ERC20_TRANSFER_SELECTOR, to, amount)
        );
    }

    function _buildExecuteUserOp(address target, uint256 value, bytes memory innerCallData)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        bytes memory execData = abi.encodePacked(target, value, innerCallData);
        ExecMode mode = ExecLib.encode(
            CALLTYPE_SINGLE, EXECTYPE_DEFAULT, ExecModeSelector.wrap(bytes4(0)), ExecModePayload.wrap(bytes22(0))
        );
        bytes memory callData = abi.encodeWithSelector(KERNEL_EXECUTE_SELECTOR, mode, execData);
        uint256 nonce = ValidatorLib.encodeAsNonce(
            bytes1(0x00), bytes1(0x01), bytes20(address(skValidator)), 0, 0
        );
        op = PackedUserOperation({
            sender: subAccount,
            nonce: nonce,
            initCode: bytes(""),
            callData: callData,
            accountGasLimits: bytes32((uint256(500_000) << 128) | uint256(300_000)),
            preVerificationGas: 100_000,
            gasFees: bytes32(uint256(2 gwei)),
            paymasterAndData: bytes(""),
            signature: bytes("")
        });
    }

    function _sign(uint256 pk, bytes32 h) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }

    /// Inner sig as seen by the validator: ECDSA(65) || abi.encode(witness).
    function _buildInnerWitnessSig(
        address to,
        uint256 value,
        uint256 validAfter_,
        uint256 validBefore_,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 usdcDigest = _usdcTransferAuthDigest(subAccount, to, value, validAfter_, validBefore_, nonce);
        bytes32 kernelDigest = _kernelWrap(usdcDigest, subAccount);
        bytes memory innerSig = _sign(sessionKeyPk, kernelDigest);
        bytes memory witness = abi.encode(to, value, validAfter_, validBefore_, nonce);
        return bytes.concat(innerSig, witness);
    }

    /// Full outer 1271 routing sig: 0x01 || validatorAddress(20) || innerWitnessSig.
    function _buildOuter1271Sig(
        address to,
        uint256 value,
        uint256 validAfter_,
        uint256 validBefore_,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes memory inner = _buildInnerWitnessSig(to, value, validAfter_, validBefore_, nonce);
        return bytes.concat(bytes1(0x01), bytes20(address(skValidator)), inner);
    }

    function _assert1271Valid(address to, uint256 value, string memory msg_) internal {
        uint256 validAfter_ = block.timestamp - 60;
        uint256 validBefore_ = block.timestamp + 600;
        bytes32 nonce = keccak256(abi.encodePacked("prod-valid-", to, value));
        bytes memory sig = _buildInnerWitnessSig(to, value, validAfter_, validBefore_, nonce);
        bytes32 kernelDigest = _kernelWrap(
            _usdcTransferAuthDigest(subAccount, to, value, validAfter_, validBefore_, nonce),
            subAccount
        );
        vm.prank(subAccount);
        assertEq(
            skValidator.isValidSignatureWithSender(address(USDC), kernelDigest, sig),
            ERC1271_MAGICVALUE,
            msg_
        );
    }

    function _assert1271Invalid(address to, uint256 value, string memory msg_) internal {
        uint256 validAfter_ = block.timestamp - 60;
        uint256 validBefore_ = block.timestamp + 600;
        bytes32 nonce = keccak256(abi.encodePacked("prod-invalid-", to, value));
        bytes memory sig = _buildInnerWitnessSig(to, value, validAfter_, validBefore_, nonce);
        bytes32 kernelDigest = _kernelWrap(
            _usdcTransferAuthDigest(subAccount, to, value, validAfter_, validBefore_, nonce),
            subAccount
        );
        vm.prank(subAccount);
        assertEq(
            skValidator.isValidSignatureWithSender(address(USDC), kernelDigest, sig),
            ERC1271_INVALID,
            msg_
        );
    }

    function _usdcTransferAuthDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter_,
        uint256 validBefore_,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 domainSep = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("USD Coin")),
                keccak256(bytes("2")),
                block.chainid,
                address(USDC)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter_, validBefore_, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    function _kernelWrap(bytes32 hash, address kernel) internal view returns (bytes32) {
        bytes32 kernelDomainSep = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Kernel")),
                keccak256(bytes("0.3.3")),
                block.chainid,
                kernel
            )
        );
        bytes32 structHash = keccak256(abi.encode(KERNEL_WRAPPER_TYPE_HASH, hash));
        return keccak256(abi.encodePacked("\x19\x01", kernelDomainSep, structHash));
    }
}
