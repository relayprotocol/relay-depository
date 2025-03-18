// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Ownable} from "solady/auth/Ownable.sol";
import {EIP712} from "solady/utils/EIP712.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/utils/SignatureCheckerLib.sol";

import {Call, CallRequest, CallResult} from "./utils/RelayEscrowStructs.sol";

/// @title RelayEscrow
/// @author Relay
contract RelayEscrow is Ownable, EIP712 {
    using SafeTransferLib for address;
    using SignatureCheckerLib for address;

    /// @notice Revert if the address is zero
    error AddressCannotBeZero();

    /// @notice Revert if the signature is invalid
    error InvalidSignature();

    /// @notice Revert if the call request is expired
    error CallRequestExpired();

    /// @notice Revert if the call request has already been used
    error CallRequestAlreadyUsed();

    /// @notice Revert if a call fails
    error CallFailed(bytes returnData);

    /// @notice Emit event when a native deposit is made
    event NativeDeposit(address from, uint256 amount, bytes32 id);

    /// @notice Emit event when an erc20 deposit is made
    event Erc20Deposit(address from, address token, uint256 amount, bytes32 id);

    /// @notice Emit event when a call is executed
    event CallRequestExecuted(bytes32 id, Call[] calls, CallResult[] results);

    /// @notice The EIP-712 typehash for the Call struct
    bytes32 public constant _CALL_TYPEHASH =
        keccak256(
            "Call(address to,bytes data,uint256 value,bool allowFailure)"
        );

    /// @notice The EIP-712 typehash for the CallRequest struct
    bytes32 public constant _CALL_REQUEST_TYPEHASH =
        keccak256(
            "CallRequest(Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
        );

    /// @notice Set of executed call requests
    mapping(bytes32 => bool) public callRequests;

    /// @notice The allocator address
    address public allocator;

    constructor(address _allocator) {
        allocator = _allocator;
        _initializeOwner(msg.sender);
    }

    /// @notice Set the allocator address
    /// @param _allocator The new allocator address
    function setAllocator(address _allocator) external onlyOwner {
        if (_allocator == address(0)) {
            revert AddressCannotBeZero();
        }
        allocator = _allocator;
    }

    /// @notice Deposit native tokens and emit a NativeDeposit event
    /// @param depositor The address of the depositor - set to `address(0)` to credit `msg.sender`
    /// @param id The id associated with the deposit
    function depositNative(address depositor, bytes32 id) external payable {
        address depositorAddress = depositor == address(0)
            ? msg.sender
            : depositor;

        // Emit the NativeDeposit event
        emit NativeDeposit(depositorAddress, msg.value, id);
    }

    /// @notice Deposit erc20 tokens and emit an Erc20Deposit event
    /// @param depositor The address of the depositor - set to `address(0)` to credit `msg.sender`
    /// @param token The erc20 token to deposit
    /// @param amount The amount to deposit
    /// @param id The id associated with the deposit
    function depositErc20(
        address depositor,
        address token,
        uint256 amount,
        bytes32 id
    ) external {
        // Transfer the tokens to the contract
        token.safeTransferFrom(msg.sender, address(this), amount);

        address depositorAddress = depositor == address(0)
            ? msg.sender
            : depositor;

        // Emit the Erc20Deposit event
        emit Erc20Deposit(depositorAddress, token, amount, id);
    }

    /// @notice Execute a CallRequest signed by the allocator
    /// @param request The CallRequest to execute
    /// @param signature The signature from the allocator
    /// @return results The results of the calls
    function execute(
        CallRequest calldata request,
        bytes memory signature
    ) external returns (CallResult[] memory results) {
        bytes32 id = _hashCallRequest(request);

        // Validate the call request expiration
        if (request.expiration < block.timestamp) {
            revert CallRequestExpired();
        }

        // Validate the allocator signature
        if (!allocator.isValidSignatureNow(id, signature)) {
            revert InvalidSignature();
        }

        // Revert if the call request has already been used
        if (callRequests[id]) {
            revert CallRequestAlreadyUsed();
        }

        // Mark the call request as used
        callRequests[id] = true;

        // Execute the calls
        results = _executeCalls(request.calls);

        // Emit the CallRequestExecuted event
        emit CallRequestExecuted(id, request.calls, results);
    }

    /// @notice Execute a list of calls
    /// @param calls The calls to execute
    /// @return returnData The results of the calls
    function _executeCalls(
        Call[] calldata calls
    ) internal returns (CallResult[] memory returnData) {
        unchecked {
            uint256 length = calls.length;

            // Initialize the return data array
            returnData = new CallResult[](length);

            // Iterate over the calls
            for (uint256 i; i < length; i++) {
                Call memory c = calls[i];

                // Execute the call
                (bool success, bytes memory data) = c.to.call{value: c.value}(
                    c.data
                );

                // Revert if the call failed and failure is not allowed
                if (!success && !c.allowFailure) {
                    revert CallFailed(data);
                }

                // Store the success status and return data
                returnData[i] = CallResult({
                    success: success,
                    returnData: data
                });
            }
        }
    }

    /// @notice Helper function to hash a CallRequest and return the EIP-712 digest
    /// @param request The CallRequest to hash
    /// @return digest The EIP-712 digest
    function _hashCallRequest(
        CallRequest calldata request
    ) internal view returns (bytes32 digest) {
        // Initialize the array of call hashes
        bytes32[] memory callHashes = new bytes32[](request.calls.length);

        // Iterate over the underlying calls
        for (uint256 i = 0; i < request.calls.length; i++) {
            // Hash the call
            bytes32 callHash = keccak256(
                abi.encode(
                    _CALL_TYPEHASH,
                    request.calls[i].to,
                    keccak256(request.calls[i].data),
                    request.calls[i].value,
                    request.calls[i].allowFailure
                )
            );

            // Store the hash in the array
            callHashes[i] = callHash;
        }

        // Get the EIP-712 digest
        digest = _hashTypedData(
            keccak256(
                abi.encode(
                    _CALL_REQUEST_TYPEHASH,
                    keccak256(abi.encodePacked(callHashes)),
                    request.nonce
                )
            )
        );
    }

    /// @notice Returns the domain name and version of the contract to be used in the domain separator
    /// @return name The domain name
    /// @return version The version
    function _domainNameAndVersion()
        internal
        pure
        override
        returns (string memory name, string memory version)
    {
        name = "RelayEscrow";
        version = "1";
    }
}
