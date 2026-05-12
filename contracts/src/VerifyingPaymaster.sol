// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {BasePaymaster} from "@account-abstraction/contracts/core/BasePaymaster.sol";
import {UserOperationLib} from "@account-abstraction/contracts/core/UserOperationLib.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IPaymaster} from "@account-abstraction/contracts/interfaces/IPaymaster.sol";
import {_packValidationData} from "@account-abstraction/contracts/core/Helpers.sol";

// Style-lint exceptions kept intentionally:
//   - `asm-keccak256` on getHash(): idiomatic `keccak256(abi.encode(...))`
//     trades ~30 gas for readability in audit-critical code.

/// @title VerifyingPaymaster
/// @notice Sponsors gas for UserOps that carry a valid off-chain signature from a trusted signer.
///         The signer is set at deployment and can be updated by the owner.
contract VerifyingPaymaster is BasePaymaster {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;
    using UserOperationLib for PackedUserOperation;

    address public verifyingSigner;

    event SignerUpdated(address indexed oldSigner, address indexed newSigner);

    constructor(IEntryPoint _entryPoint, address _verifyingSigner) BasePaymaster(_entryPoint) {
        require(_verifyingSigner != address(0), "zero signer");
        verifyingSigner = _verifyingSigner;
    }

    function setVerifyingSigner(address _newSigner) external onlyOwner {
        require(_newSigner != address(0), "zero signer");
        emit SignerUpdated(verifyingSigner, _newSigner);
        verifyingSigner = _newSigner;
    }

    /// @dev paymasterAndData layout:
    ///   [0:20]   paymaster address (handled by EntryPoint, not in paymasterData)
    ///   Paymaster data (after PAYMASTER_DATA_OFFSET):
    ///     [0:6]    validUntil (uint48)
    ///     [6:12]   validAfter (uint48)
    ///     [12:77]  signature (65 bytes: r[32] + s[32] + v[1])
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /*userOpHash*/,
        uint256 /*maxCost*/
    ) internal view override returns (bytes memory context, uint256 validationData) {
        bytes calldata paymasterData = userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:];
        require(paymasterData.length == 77, "invalid paymaster data length");

        uint48 validUntil = uint48(bytes6(paymasterData[:6]));
        uint48 validAfter = uint48(bytes6(paymasterData[6:12]));
        bytes calldata signature = paymasterData[12:77];

        bytes32 hash = getHash(userOp, validUntil, validAfter).toEthSignedMessageHash();
        address signer = hash.recover(signature);

        if (signer != verifyingSigner) {
            return ("", _packValidationData(true, validUntil, validAfter));
        }

        return ("", _packValidationData(false, validUntil, validAfter));
    }

    /// @notice Compute the hash that the verifying signer must sign.
    function getHash(
        PackedUserOperation calldata userOp,
        uint48 validUntil,
        uint48 validAfter
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                userOp.getSender(),
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                userOp.preVerificationGas,
                userOp.gasFees,
                keccak256(userOp.paymasterAndData[:PAYMASTER_DATA_OFFSET]),
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    /// @dev No postOp needed — we return empty context.
    function _postOp(
        IPaymaster.PostOpMode,
        bytes calldata,
        uint256,
        uint256
    ) internal pure override {
        // no-op
    }
}
