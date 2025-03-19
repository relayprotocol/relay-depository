// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

struct Call {
    address to;
    bytes data;
    uint256 value;
    bool allowFailure;
}

struct CallRequest {
    Call[] calls;
    uint256 nonce;
    uint256 expiration;
}

struct CallResult {
    bool success;
    bytes returnData;
}
