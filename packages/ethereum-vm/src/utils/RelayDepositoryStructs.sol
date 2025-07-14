// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @notice A structure representing a single call to be executed
/// @param to The target contract address to call
/// @param data The calldata to send to the target
/// @param value The amount of native currency to send with the call
/// @param allowFailure Whether the call is allowed to fail without reverting the entire transaction
struct Call {
    address to;
    bytes data;
    uint256 value;
    bool allowFailure;
}

/// @notice A request containing multiple calls to be executed after signature verification
/// @param calls Array of Call structures to execute
/// @param nonce Unique identifier to prevent replay attacks
/// @param expiration Unix timestamp after which the request is no longer valid
struct CallRequest {
    Call[] calls;
    uint256 nonce;
    uint256 expiration;
}

/// @notice The result of an executed call
/// @param success Whether the call executed successfully
/// @param returnData The data returned by the call
struct CallResult {
    bool success;
    bytes returnData;
}
