// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

// Used for minting test ERC721s in our tests
contract TestERC721_ERC20PaymentToken is ERC721 {
    IERC20 public paymentToken;
    uint256 public constant MINT_PRICE = 20 * 10 ** 6;

    constructor(address _paymentTokenAddress) ERC721("MyNFT", "MNFT") {
        paymentToken = IERC20(_paymentTokenAddress);
    }

    function mint(address to, uint256 tokenId) public returns (bool) {
        require(
            paymentToken.transferFrom(msg.sender, address(this), MINT_PRICE),
            "Payment failed"
        );
        _mint(to, tokenId);
        return true;
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "tokenURI";
    }
}
