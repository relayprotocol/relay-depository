// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.13;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Used for minting test ERC20s in our tests
contract TestERC20 is ERC20("Test20", "TST20") {
    constructor() {}

    function mint(address to, uint256 amount) external returns (bool) {
        _mint(to, amount);
        return true;
    }

    function increaseAllowance(address spender, uint256 amount)
        external
        returns (bool)
    {
        uint256 current = allowance(msg.sender, spender);
        uint256 remaining = type(uint256).max - current;
        if (amount > remaining) {
            amount = remaining;
        }
        approve(spender, current + amount);
        return true;
    }
}
