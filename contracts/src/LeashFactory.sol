// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Kernel} from "kernel/Kernel.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {ECDSAValidator} from "kernel/validator/ECDSAValidator.sol";
import {IHook} from "kernel/interfaces/IERC7579Modules.sol";
import {ValidationId} from "kernel/types/Types.sol";

/// LeashFactory — thin wrapper over ZeroDev's `KernelFactory` that deploys
/// Kernel v3.3 proxies with deterministic addresses and an on-chain
/// registry mapping `owner EOA → hub` and `hub → sub-accounts`.
///
/// Shape:
///   - One **hub** per owner EOA. CREATE2 salt = keccak("leash:hub:", owner).
///     Hub is a Kernel v3.3 proxy with ECDSAValidator(owner = the EOA) as root.
///   - One **sub-account** per (hub, agentName) pair. Same Kernel config as the
///     hub (ECDSAValidator same-EOA root); only the CREATE2 salt differs.
///   - No on-chain paymaster coupling — PoC-D (see summary/paymaster-scope.md)
///     picked signature-only gating, so this factory is a pure registry.
///
/// Simplification vs early architecture: the sub-account's root validator is
/// *not* the hub contract; it's the same EOA that owns the hub. The hub→sub
/// relationship is tracked in this factory's registry, not in a validator
/// chain. Blast-radius property (leaked session key drains only the sub) is
/// preserved because session keys are installed only on the sub.
//
// Style-lint exceptions kept intentionally:
//   - `screaming-snake-case-immutable` on `kernelFactory` /
//     `ecdsaValidator`: they are `public immutable`, so Solidity
//     auto-generates getters named identically. Renaming to
//     KERNEL_FACTORY / ECDSA_VALIDATOR would change the getter names
//     and break external callers (BaseScan's Read tab, integrators'
//     cached ABIs, our own generated TS ABIs). Kept in mixedCase.
//   - `asm-keccak256` on the salt computations: the asm alternative
//     saves ~30 gas at meaningful readability cost; audit-critical
//     code trades the other way.
contract LeashFactory {
    KernelFactory public immutable kernelFactory;
    ECDSAValidator public immutable ecdsaValidator;

    // Registries.
    mapping(address owner => address hub) public hubOf;
    mapping(address hub => address owner) public ownerOfHub;
    mapping(address hub => mapping(bytes32 agentNameHash => address sub)) public subOf;
    mapping(address sub => address hub) public hubOfSub;
    mapping(address sub => bytes32 agentNameHash) public nameHashOfSub;
    mapping(address hub => address[]) internal _subsOfHub;

    error HubAlreadyDeployed(address owner, address hub);
    error HubNotDeployed(address owner);
    error SubAlreadyDeployed(address hub, bytes32 nameHash, address sub);
    error UnknownHub(address hub);

    event HubDeployed(address indexed owner, address indexed hub);
    event SubAccountDeployed(
        address indexed hub,
        address indexed sub,
        bytes32 indexed agentNameHash,
        string agentName
    );

    constructor(KernelFactory _kernelFactory, ECDSAValidator _ecdsaValidator) {
        kernelFactory = _kernelFactory;
        ecdsaValidator = _ecdsaValidator;
    }

    /// Deploy the hub for `msg.sender`. Reverts if already deployed.
    function deployHub() external returns (address hub) {
        if (hubOf[msg.sender] != address(0)) {
            revert HubAlreadyDeployed(msg.sender, hubOf[msg.sender]);
        }
        hub = _deployKernel(msg.sender, _hubSalt(msg.sender));
        hubOf[msg.sender] = hub;
        ownerOfHub[hub] = msg.sender;
        emit HubDeployed(msg.sender, hub);
    }

    /// Deploy a sub-account under `msg.sender`'s hub. Reverts if the hub is
    /// not yet deployed, or if a sub-account with this name already exists.
    function deploySubAccount(string calldata agentName) external returns (address sub) {
        address hub = hubOf[msg.sender];
        if (hub == address(0)) revert HubNotDeployed(msg.sender);
        bytes32 nameHash = keccak256(bytes(agentName));
        if (subOf[hub][nameHash] != address(0)) {
            revert SubAlreadyDeployed(hub, nameHash, subOf[hub][nameHash]);
        }
        sub = _deployKernel(msg.sender, _subSalt(hub, nameHash));
        subOf[hub][nameHash] = sub;
        hubOfSub[sub] = hub;
        nameHashOfSub[sub] = nameHash;
        _subsOfHub[hub].push(sub);
        emit SubAccountDeployed(hub, sub, nameHash, agentName);
    }

    /// Counterfactual hub address (same salt whether deployed or not).
    function computeHubAddress(address owner) external view returns (address) {
        return kernelFactory.getAddress(_initCalldata(owner), _hubSalt(owner));
    }

    /// Counterfactual sub-account address. Hub must already be registered so
    /// the correct owner can be resolved.
    function computeSubAccountAddress(address hub, string calldata agentName)
        external
        view
        returns (address)
    {
        address owner = ownerOfHub[hub];
        if (owner == address(0)) revert UnknownHub(hub);
        return kernelFactory.getAddress(
            _initCalldata(owner),
            _subSalt(hub, keccak256(bytes(agentName)))
        );
    }

    /// Enumerate sub-accounts under a hub (cheap read for `leash status`).
    function subsOfHub(address hub) external view returns (address[] memory) {
        return _subsOfHub[hub];
    }

    /// Sub-account count under a hub.
    function subCount(address hub) external view returns (uint256) {
        return _subsOfHub[hub].length;
    }

    // --- internal ---

    function _deployKernel(address owner, bytes32 salt) internal returns (address) {
        return kernelFactory.createAccount(_initCalldata(owner), salt);
    }

    /// Kernel initialize calldata — ECDSAValidator(owner = the EOA) as root,
    /// no hook, no initial modules. Identical for hub and sub-accounts.
    function _initCalldata(address owner) internal view returns (bytes memory) {
        ValidationId rootVId = ValidationId.wrap(
            bytes21(abi.encodePacked(bytes1(0x01), address(ecdsaValidator)))
        );
        return abi.encodeWithSelector(
            Kernel.initialize.selector,
            rootVId,
            IHook(address(0)),
            abi.encodePacked(owner),
            bytes(""),
            new bytes[](0)
        );
    }

    function _hubSalt(address owner) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("leash:hub:", owner));
    }

    function _subSalt(address hub, bytes32 nameHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("leash:sub:", hub, nameHash));
    }
}
