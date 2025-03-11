// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

struct Call {
    address target;
    bytes callData;
}

struct Call3 {
    address target;
    bool allowFailure;
    bytes callData;
}

struct Call3Value {
    address target;
    bool allowFailure;
    uint256 value;
    bytes callData;
}

struct CallRequest {
    Call3Value[] call3Values;
    uint256 nonce;
}

struct Permit {
    address token;
    address owner;
    uint256 value;
    uint256 nonce;
    uint256 deadline;
    uint8 v;
    bytes32 r;
    bytes32 s;
}

struct Result {
    bool success;
    bytes returnData;
}

struct RelayerWitness {
    address relayer;
    Call3Value[] call3Values;
}
