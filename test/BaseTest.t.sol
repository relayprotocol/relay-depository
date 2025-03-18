// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";

contract BaseTest is Test {
    Account alice;
    Account bob;

    TestERC20 erc20_1;
    TestERC20 erc20_2;
    TestERC20 erc20_3;

    function setUp() public virtual {
        alice = makeAccountAndDeal("alice", 10 ether);
        bob = makeAccountAndDeal("bob", 10 ether);
        cal = makeAccountAndDeal("cal", 10 ether);
        erc20_1 = new TestERC20();
        erc20_2 = new TestERC20();
        erc20_3 = new TestERC20();

        erc20_1.mint(address(this), 100 ether);
        erc20_2.mint(address(this), 100 ether);
        erc20_3.mint(address(this), 100 ether);
    }

    function makeAccountAndDeal(
        string memory name,
        uint256 amount
    ) internal returns (Account memory) {
        (address addr, uint256 pk) = makeAddrAndKey(name);

        vm.deal(addr, amount);

        return Account({addr: addr, key: pk});
    }
}
