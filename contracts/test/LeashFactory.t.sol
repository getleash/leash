// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Kernel} from "kernel/Kernel.sol";
import {KernelFactory} from "kernel/factory/KernelFactory.sol";
import {ECDSAValidator} from "kernel/validator/ECDSAValidator.sol";
import {IEntryPoint} from "kernel/interfaces/IEntryPoint.sol";

import {LeashFactory} from "../src/LeashFactory.sol";

/// Unit tests for LeashFactory. Fork-local (doesn't need Base state).
contract LeashFactoryTest is Test {
    IEntryPoint constant ENTRYPOINT_V07 = IEntryPoint(0x0000000071727De22E5E9d8BAf0edAc6f37da032);

    Kernel kernelImpl;
    KernelFactory kernelFactory;
    ECDSAValidator ecdsaValidator;
    LeashFactory factory;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        // EntryPoint doesn't actually need to exist for factory registry tests;
        // we just need Kernel construction to succeed.
        vm.etch(address(ENTRYPOINT_V07), hex"00");
        kernelImpl = new Kernel(ENTRYPOINT_V07);
        kernelFactory = new KernelFactory(address(kernelImpl));
        ecdsaValidator = new ECDSAValidator();
        factory = new LeashFactory(kernelFactory, ecdsaValidator);
    }

    // --- happy paths ---

    function test_DeployHub_Happy() public {
        address predicted = factory.computeHubAddress(alice);
        vm.prank(alice);
        address hub = factory.deployHub();
        assertEq(hub, predicted, "deployed address matches computed");
        assertEq(factory.hubOf(alice), hub, "hubOf mapping set");
        assertEq(factory.ownerOfHub(hub), alice, "ownerOfHub mapping set");
        assertTrue(hub.code.length > 0, "hub contract deployed");
    }

    function test_DeployHub_DifferentOwnersGetDifferentHubs() public {
        vm.prank(alice);
        address aliceHub = factory.deployHub();
        vm.prank(bob);
        address bobHub = factory.deployHub();
        assertTrue(aliceHub != bobHub, "hubs must differ per owner");
    }

    function test_DeploySubAccount_Happy() public {
        vm.prank(alice);
        address hub = factory.deployHub();

        address predicted = factory.computeSubAccountAddress(hub, "cryptonit");
        vm.prank(alice);
        address sub = factory.deploySubAccount("cryptonit");

        assertEq(sub, predicted, "deployed sub address matches computed");
        assertEq(factory.hubOfSub(sub), hub, "hubOfSub mapping set");
        assertEq(
            factory.subOf(hub, keccak256(bytes("cryptonit"))),
            sub,
            "subOf mapping set"
        );
        assertEq(factory.subCount(hub), 1);
        address[] memory subs = factory.subsOfHub(hub);
        assertEq(subs.length, 1);
        assertEq(subs[0], sub);
    }

    function test_DeploySubAccount_MultipleAgentsPerHub() public {
        vm.prank(alice);
        address hub = factory.deployHub();

        vm.prank(alice);
        address sub1 = factory.deploySubAccount("cryptonit");
        vm.prank(alice);
        address sub2 = factory.deploySubAccount("analyst");

        assertTrue(sub1 != sub2, "different agent names -> different addresses");
        assertEq(factory.subCount(hub), 2);
    }

    // --- negatives ---

    function test_DeployHub_RevertsIfAlreadyDeployed() public {
        vm.prank(alice);
        factory.deployHub();
        vm.prank(alice);
        vm.expectRevert();
        factory.deployHub();
    }

    function test_DeploySubAccount_RevertsIfHubNotDeployed() public {
        vm.prank(alice);
        vm.expectRevert();
        factory.deploySubAccount("cryptonit");
    }

    function test_DeploySubAccount_RevertsIfDuplicate() public {
        vm.prank(alice);
        factory.deployHub();
        vm.prank(alice);
        factory.deploySubAccount("cryptonit");
        vm.prank(alice);
        vm.expectRevert();
        factory.deploySubAccount("cryptonit");
    }

    function test_ComputeSubAccountAddress_RevertsOnUnknownHub() public {
        vm.expectRevert();
        factory.computeSubAccountAddress(address(0xDEADBEEF), "cryptonit");
    }

    // --- determinism ---

    function test_ComputeHubAddress_DoesNotDependOnDeploymentState() public {
        address beforeDeploy = factory.computeHubAddress(alice);
        vm.prank(alice);
        address hub = factory.deployHub();
        address afterDeploy = factory.computeHubAddress(alice);
        assertEq(beforeDeploy, hub, "counterfactual == deployed");
        assertEq(afterDeploy, hub, "counterfactual stable after deploy");
    }

    function test_ComputeSubAccountAddress_DoesNotDependOnDeploymentState() public {
        vm.prank(alice);
        address hub = factory.deployHub();
        address beforeDeploy = factory.computeSubAccountAddress(hub, "cryptonit");
        vm.prank(alice);
        address sub = factory.deploySubAccount("cryptonit");
        assertEq(beforeDeploy, sub);
    }
}
