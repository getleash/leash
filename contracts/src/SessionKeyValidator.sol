// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "solady/utils/ECDSA.sol";
import {IValidator} from "kernel/interfaces/IERC7579Modules.sol";
import {PackedUserOperation} from "kernel/interfaces/PackedUserOperation.sol";
import {ExecLib} from "kernel/utils/ExecLib.sol";
import {CallType, ExecMode} from "kernel/types/Types.sol";
import {CALLTYPE_SINGLE} from "kernel/types/Constants.sol";
import {
    MODULE_TYPE_VALIDATOR,
    ERC1271_MAGICVALUE,
    ERC1271_INVALID,
    SIG_VALIDATION_SUCCESS_UINT,
    SIG_VALIDATION_FAILED_UINT
} from "kernel/types/Constants.sol";

/// SessionKeyValidator — ERC-7579 validator intended to run as a **secondary**
/// (non-root) module on Kernel v3.3. Hub-ECDSA stays as root.
///
/// UserOp path: signer + expiry + (target, selector, msg.value) allowlist
/// parsed from Kernel's `execute(bytes32 mode, bytes data)` calldata. Only
/// CALLTYPE_SINGLE is supported for MVP; batch / delegatecall out of scope.
///
/// 1271 path: signer + expiry + **on-chain per-recipient amount enforcement**
/// for EIP-3009 / x402 payments. The signature carries the
/// `TransferWithAuthorization` fields as witness data after the ECDSA portion.
/// The validator rebuilds the USDC + Kernel-wrapped digest from the witness,
/// requires it equals the supplied `hash`, then enforces a per-recipient amount
/// cap (`maxValueByRecipient[kernel][to]`). Rolling daily/weekly caps still
/// live in the MCP SQLite layer (gas-prohibitive on-chain).
///
/// Signature layout the validator sees (after Kernel strips its outer routing
/// prefix `0x01 || validatorAddress`):
/// ```
/// r (32) || s (32) || v (1) || abi.encode(
///     address to,
///     uint256 value,
///     uint256 validAfter,
///     uint256 validBefore,
///     bytes32 nonce
/// )
/// ```
/// `from` is implicit: `msg.sender` of the `isValidSignatureWithSender` call
/// is the sub-account that USDC's SignatureChecker is verifying against.
///
/// Per-recipient cap mapping:
///   - `maxValueByRecipient[k][r] == 0` → recipient not allowlisted, deny.
///   - `maxValueByRecipient[k][r] > 0`  → allowlisted; cap is the per-payment upper bound.
/// The same SLOAD does double duty (allowlist check + cap value).
///
/// See `summary/eip3009-policy-enforcement.md` for the spike that motivated
/// this design and the Go decision.
contract SessionKeyValidator is IValidator {
    // ============================================================
    // Constants
    // ============================================================

    // Kernel's execute(bytes32,bytes) selector = bytes4(keccak256("execute(bytes32,bytes)"))
    bytes4 internal constant EXECUTE_SELECTOR = 0xe9ae5c53;

    // Base mainnet USDC FiatTokenV2_2 — the only token Leash MVP supports.
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    // Kernel v3.3's outer wrapper typehash — `keccak256("Kernel(bytes32 hash)")`.
    bytes32 internal constant KERNEL_WRAPPER_TYPE_HASH =
        0x1547321c374afde8a591d972a084b071c594c275e36724931ff96c25f2999c83;

    // Witness payload size: abi.encode of 5 fixed-size words.
    uint256 internal constant WITNESS_LEN = 5 * 32;
    uint256 internal constant ECDSA_LEN = 65;
    uint256 internal constant MIN_SIG_LEN = ECDSA_LEN + WITNESS_LEN;

    // ============================================================
    // Storage
    // ============================================================

    struct Session {
        address signer;
        uint48 validUntil;     // 0 = unset
        uint256 maxValuePerTx; // UserOp path msg.value cap
        // Allowlists are in separate mappings (Solidity doesn't allow
        // mappings inside structs that live in mappings).
    }

    mapping(address kernel => Session) public sessions;

    // UserOp-path allowlists.
    mapping(address kernel => mapping(address target => bool)) public allowedTargets;
    mapping(address kernel => mapping(bytes4 selector => bool)) public allowedSelectors;

    /// x402 / 1271-path per-recipient cap. 0 = not allowlisted (denied).
    mapping(address kernel => mapping(address recipient => uint256 cap)) public maxValueByRecipient;

    // Tracked so onUninstall can zero out the allowlists deterministically.
    mapping(address kernel => address[]) private _installedTargets;
    mapping(address kernel => bytes4[]) private _installedSelectors;
    mapping(address kernel => address[]) private _installedRecipients;

    // ============================================================
    // Errors / events
    // ============================================================

    error SessionNotInitialized(address kernel);
    error SessionAlreadyInitialized(address kernel);
    error RecipientCapLengthMismatch();
    error ZeroRecipientCap(address recipient);

    event SessionInstalled(
        address indexed kernel,
        address indexed signer,
        uint48 validUntil,
        uint256 maxValuePerTx,
        address[] targets,
        bytes4[] selectors,
        address[] recipients,
        uint256[] recipientCaps
    );
    event SessionRevoked(address indexed kernel);

    // ============================================================
    // ERC-7579 lifecycle
    // ============================================================

    /// install data layout (abi.encode):
    ///   (address signer,
    ///    uint48 validUntil,
    ///    uint256 maxValuePerTx,
    ///    address[] targets,
    ///    bytes4[] selectors,
    ///    address[] recipients,
    ///    uint256[] recipientCaps)
    function onInstall(bytes calldata data) external payable override {
        if (sessions[msg.sender].signer != address(0)) revert SessionAlreadyInitialized(msg.sender);
        (
            address signer,
            uint48 validUntil,
            uint256 maxValuePerTx,
            address[] memory targets,
            bytes4[] memory selectors,
            address[] memory recipients,
            uint256[] memory recipientCaps
        ) = abi.decode(data, (address, uint48, uint256, address[], bytes4[], address[], uint256[]));

        if (recipients.length != recipientCaps.length) revert RecipientCapLengthMismatch();

        sessions[msg.sender] = Session({
            signer: signer,
            validUntil: validUntil,
            maxValuePerTx: maxValuePerTx
        });
        for (uint256 i = 0; i < targets.length; i++) {
            allowedTargets[msg.sender][targets[i]] = true;
            _installedTargets[msg.sender].push(targets[i]);
        }
        for (uint256 i = 0; i < selectors.length; i++) {
            allowedSelectors[msg.sender][selectors[i]] = true;
            _installedSelectors[msg.sender].push(selectors[i]);
        }
        for (uint256 i = 0; i < recipients.length; i++) {
            // Zero is the "denied" sentinel; explicit-zero install is a config bug.
            if (recipientCaps[i] == 0) revert ZeroRecipientCap(recipients[i]);
            maxValueByRecipient[msg.sender][recipients[i]] = recipientCaps[i];
            _installedRecipients[msg.sender].push(recipients[i]);
        }
        emit SessionInstalled(
            msg.sender, signer, validUntil, maxValuePerTx, targets, selectors, recipients, recipientCaps
        );
    }

    function onUninstall(bytes calldata) external payable override {
        if (sessions[msg.sender].signer == address(0)) revert SessionNotInitialized(msg.sender);
        address[] storage tgts = _installedTargets[msg.sender];
        for (uint256 i = 0; i < tgts.length; i++) {
            delete allowedTargets[msg.sender][tgts[i]];
        }
        bytes4[] storage sels = _installedSelectors[msg.sender];
        for (uint256 i = 0; i < sels.length; i++) {
            delete allowedSelectors[msg.sender][sels[i]];
        }
        address[] storage recips = _installedRecipients[msg.sender];
        for (uint256 i = 0; i < recips.length; i++) {
            delete maxValueByRecipient[msg.sender][recips[i]];
        }
        delete _installedTargets[msg.sender];
        delete _installedSelectors[msg.sender];
        delete _installedRecipients[msg.sender];
        delete sessions[msg.sender];
        emit SessionRevoked(msg.sender);
    }

    function isModuleType(uint256 typeId) external pure override returns (bool) {
        return typeId == MODULE_TYPE_VALIDATOR;
    }

    function isInitialized(address kernel) external view override returns (bool) {
        return sessions[kernel].signer != address(0);
    }

    // ============================================================
    // 1271 path — witness-bearing signature, per-recipient cap
    // ============================================================

    function isValidSignatureWithSender(address, bytes32 hash, bytes calldata sig)
        external
        view
        override
        returns (bytes4)
    {
        if (sig.length < MIN_SIG_LEN) return ERC1271_INVALID;

        Session memory s = sessions[msg.sender];
        if (s.signer == address(0)) return ERC1271_INVALID;
        if (block.timestamp > s.validUntil) return ERC1271_INVALID;

        // Decode witness from bytes [65:].
        (
            address to,
            uint256 value,
            uint256 validAfter,
            uint256 validBefore,
            bytes32 nonce
        ) = abi.decode(sig[ECDSA_LEN:], (address, uint256, uint256, uint256, bytes32));

        // Rebuild USDC EIP-3009 digest from witness. `from` is the sub-account
        // (msg.sender of this call — USDC's SignatureChecker provides it).
        bytes32 usdcDigest = _usdcTransferAuthDigest(
            msg.sender, to, value, validAfter, validBefore, nonce
        );

        // Rebuild the Kernel-wrap envelope.
        bytes32 kernelDigest = _kernelWrap(usdcDigest, msg.sender);

        // Bind witness to signed hash. If they don't match, the witness was
        // tampered or the signature was constructed for a different message.
        if (kernelDigest != hash) return ERC1271_INVALID;

        // Recover signer from the inner ECDSA portion.
        address recovered = ECDSA.recover(hash, sig[:ECDSA_LEN]);
        if (recovered != s.signer) return ERC1271_INVALID;

        // Per-recipient cap. Same SLOAD does double duty (allowlist + cap).
        uint256 cap = maxValueByRecipient[msg.sender][to];
        if (cap == 0) return ERC1271_INVALID;
        if (value > cap) return ERC1271_INVALID;

        // Defense-in-depth: the EIP-3009 expiry can't outlive the session.
        if (validBefore > s.validUntil) return ERC1271_INVALID;

        return ERC1271_MAGICVALUE;
    }

    // ============================================================
    // UserOp path — unchanged from v1
    // ============================================================

    /// UserOp path — signer + expiry + (target, selector, msg.value) allowlist.
    /// Only CALLTYPE_SINGLE is supported; anything else rejects.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        payable
        override
        returns (uint256)
    {
        Session memory s = sessions[msg.sender];
        if (s.signer == address(0)) return SIG_VALIDATION_FAILED_UINT;
        if (block.timestamp > s.validUntil) return SIG_VALIDATION_FAILED_UINT;

        address recovered = ECDSA.recover(userOpHash, userOp.signature);
        if (recovered != s.signer) return SIG_VALIDATION_FAILED_UINT;

        if (!_isExecuteAllowed(userOp.callData, s.maxValuePerTx)) {
            return SIG_VALIDATION_FAILED_UINT;
        }
        return SIG_VALIDATION_SUCCESS_UINT;
    }

    /// Parse `execute(bytes32 mode, bytes data)` calldata from a UserOp and
    /// check the (target, selector, value) triple against this session's
    /// allowlist. Returns false on any mismatch (including unsupported
    /// calltypes or malformed calldata).
    function _isExecuteAllowed(bytes calldata callData, uint256 maxValuePerTx)
        internal
        view
        returns (bool)
    {
        if (callData.length < 4) return false;
        if (bytes4(callData[0:4]) != EXECUTE_SELECTOR) return false;

        // abi.encode of (bytes32, bytes) after the 4-byte selector:
        //   [4:36]  mode
        //   [36:68] offset to `data` payload (always 0x40)
        //   [68:100] length of `data`
        //   [100:100+len] `data` content
        if (callData.length < 100) return false;
        ExecMode mode = ExecMode.wrap(bytes32(callData[4:36]));
        uint256 offsetAfterSelector = uint256(bytes32(callData[36:68]));
        uint256 dataHeaderPos = 4 + offsetAfterSelector;
        if (callData.length < dataHeaderPos + 32) return false;
        uint256 dataLen = uint256(bytes32(callData[dataHeaderPos:dataHeaderPos + 32]));
        uint256 dataStart = dataHeaderPos + 32;
        if (callData.length < dataStart + dataLen) return false;
        bytes calldata execData = callData[dataStart:dataStart + dataLen];

        (CallType callType,,,) = ExecLib.decode(mode);
        if (CallType.unwrap(callType) != CallType.unwrap(CALLTYPE_SINGLE)) return false;

        if (execData.length < 52) return false;
        (address target, uint256 value, bytes calldata innerCallData) =
            ExecLib.decodeSingle(execData);
        if (innerCallData.length < 4) return false;

        if (!allowedTargets[msg.sender][target]) return false;
        if (value > maxValuePerTx) return false;
        bytes4 innerSelector = bytes4(innerCallData[0:4]);
        if (!allowedSelectors[msg.sender][innerSelector]) return false;

        return true;
    }

    // ============================================================
    // Digest helpers
    // ============================================================

    function _usdcTransferAuthDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 domainSep = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("USD Coin")),
                keccak256(bytes("2")),
                block.chainid,
                USDC
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
            )
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
