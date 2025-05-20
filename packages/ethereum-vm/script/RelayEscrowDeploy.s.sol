// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";

import {RelayEscrow} from "../src/RelayEscrow.sol";

contract RelayEscrowDeploy is Script {
    function setUp() public {}

    function run() public {
        vm.createSelectFork(vm.envString("CHAIN"));

        vm.startBroadcast();

        address allocator = vm.envAddress("ALLOCATOR");

        RelayEscrow relayEscrow = new RelayEscrow(allocator);

        assert(relayEscrow.allocator() == allocator);
        assert(relayEscrow.owner() == msg.sender);

        vm.stopBroadcast();
    }
}
