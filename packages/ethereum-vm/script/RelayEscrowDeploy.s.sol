// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";

import {RelayEscrow} from "../src/RelayEscrow.sol";

contract RelayEscrowDeploy is Script {
    address allocator;

    function setUp() public {}

    function run() public {
        vm.createSelectFork(vm.envString("CHAIN"));

        vm.startBroadcast();

        RelayEscrow relayEscrow = new RelayEscrow(msg.sender);

        assert(relayEscrow.allocator() == msg.sender);
        assert(relayEscrow.owner() == msg.sender);

        vm.stopBroadcast();
    }
}
