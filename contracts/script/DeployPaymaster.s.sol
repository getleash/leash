// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {VerifyingPaymaster} from "../src/VerifyingPaymaster.sol";

contract DeployPaymaster is Script {
    address constant ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address verifyingSigner = vm.envAddress("PAYMASTER_SIGNER_ADDRESS");

        vm.startBroadcast(deployerKey);

        VerifyingPaymaster paymaster = new VerifyingPaymaster(IEntryPoint(ENTRYPOINT_V07), verifyingSigner);

        // Deposit ETH to EntryPoint for gas sponsorship
        uint256 depositAmount = vm.envOr("PAYMASTER_DEPOSIT", uint256(0.00005 ether));
        if (depositAmount > 0 && address(vm.addr(deployerKey)).balance >= depositAmount) {
            paymaster.deposit{value: depositAmount}();
            console.log("Deposited to EntryPoint:", depositAmount);
        }

        // Stake (required by EntryPoint for paymasters)
        uint256 stakeAmount = vm.envOr("PAYMASTER_STAKE", uint256(0.00001 ether));
        if (stakeAmount > 0 && address(vm.addr(deployerKey)).balance >= stakeAmount) {
            paymaster.addStake{value: stakeAmount}(86400); // 1 day unstake delay
            console.log("Staked:", stakeAmount);
        }

        vm.stopBroadcast();

        console.log("VerifyingPaymaster deployed at:", address(paymaster));
        console.log("Verifying signer:", verifyingSigner);
        console.log("Paymaster deposit:", paymaster.getDeposit());
    }
}
