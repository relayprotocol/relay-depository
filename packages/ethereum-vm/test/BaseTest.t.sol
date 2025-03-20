// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";

import {TestERC20} from "./mocks/TestERC20.sol";

contract BaseTest is Test {
    Account alice;
    Account bob;

    TestERC20 erc20;

    function setUp() public virtual {
        alice = makeAccountAndDeal("alice", 10 ether);
        bob = makeAccountAndDeal("bob", 10 ether);

        erc20 = new TestERC20();
        erc20.mint(address(this), 100 ether);
    }

    function makeAccountAndDeal(string memory name, uint256 amount) internal returns (Account memory) {
        (address addr, uint256 pk) = makeAddrAndKey(name);

        vm.deal(addr, amount);

        return Account({addr: addr, key: pk});
    }
}
