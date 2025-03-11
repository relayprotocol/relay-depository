// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {EIP712} from "solady/src/utils/EIP712.sol";
import {Ownable} from "solady/src/auth/Ownable.sol";
import {SafeTransferLib} from "solady/src/utils/SafeTransferLib.sol";
import {SignatureCheckerLib} from "solady/src/utils/SignatureCheckerLib.sol";
import {Call3Value, CallRequest, Result} from "./utils/RelayStructs.sol";

// TODO: add sender to CallRequest struct (confirm with SB)

/// @title  CreditMaster
/// @author Reservoir
contract CreditMaster is Ownable, EIP712 {
    using SafeTransferLib for address;
    using SignatureCheckerLib for address;

    /// @notice Revert if the address is zero
    error AddressCannotBeZero();

    /// @notice Revert if the signature is invalid
    error InvalidSignature();

    /// @notice Revert if the call request has already been used
    error CallRequestAlreadyUsed();

    /// @notice Revert if a call fails
    error CallFailed(bytes returnData);

    /// @notice Emit event when a deposit is made
    event Deposit(address depositor, address token, uint256 value, bytes32 id);

    /// @notice Emit event when a call is executed
    event CallExecuted(bytes32 digest, address target, bool success);

    /// @notice The EIP-712 typehash for the Call3Value struct
    bytes32 public constant _CALL3VALUE_TYPEHASH =
        keccak256(
            "Call3Value(address target,bool allowFailure,uint256 value,bytes callData)"
        );

    /// @notice The EIP-712 typehash for the CallRequest struct
    bytes32 public constant _CALL_REQUEST_TYPEHASH =
        keccak256(
            "CallRequest(Call3Value[] call3Values,uint256 nonce)Call3Value(address target,bool allowFailure,uint256 value,bytes callData)"
        );

    /// @notice Mapping from call request digests to boolean values
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

    /// @notice Deposit native tokens to the contract and emit a Deposit event
    /// @param depositor The address of the depositor to credit. Set to address(0) to credit msg.sender
    /// @param id The id associated with the transfer
    function depositNative(address depositor, bytes32 id) external payable {
        address depositorAddress = depositor == address(0)
            ? msg.sender
            : depositor;

        // Emit the Deposit event
        emit Deposit(depositorAddress, address(0), msg.value, id);
    }

    /// @notice Deposit ERC20 token from msg.sender to the contract and emit a Deposit event
    /// @param depositor The address of the depositor to credit. Set to address(0) to credit msg.sender
    /// @param token The ERC20 token to transfer
    /// @param amount The amount to transfer
    /// @param id The id associated with the transfer
    function depositErc20(
        address depositor,
        address token,
        uint256 amount,
        bytes32 id
    ) external {
        // Transfer the tokens to the contract
        token.safeTransferFrom(msg.sender, address(this), amount);

        // Get the depositor address
        address depositorAddress = depositor == address(0)
            ? msg.sender
            : depositor;

        // Emit the Deposit event
        emit Deposit(depositorAddress, token, amount, id);
    }

    /// @notice Execute a set of calls with a signed Calls struct from the Allocator
    /// @param request The CallRequest struct
    /// @param signature The signature from the Allocator
    /// @return returnData The results of the calls
    function execute(
        CallRequest calldata request,
        bytes memory signature
    ) external returns (Result[] memory returnData) {
        bytes32 digest = _hashCallRequest(request);

        // Validate the allocator signature
        if (!allocator.isValidSignatureNow(digest, signature)) {
            revert InvalidSignature();
        }

        // Revert if the call request has already been used
        if (callRequests[digest]) {
            revert CallRequestAlreadyUsed();
        }

        // Mark the call request as used
        callRequests[digest] = true;

        // Execute the calls
        returnData = _executeCalls(request.call3Values, digest);
    }

    /// @notice Execute a set of calls
    /// @param calls The calls to execute
    /// @param digest The digest of the call request
    /// @return returnData The results of the calls
    function _executeCalls(
        Call3Value[] calldata calls,
        bytes32 digest
    ) internal returns (Result[] memory returnData) {
        unchecked {
            uint256 length = calls.length;

            // Initialize the return data array
            returnData = new Result[](length);

            // Iterate over the calls
            for (uint256 i; i < length; i++) {
                Call3Value memory c = calls[i];

                // Execute the call
                (bool success, bytes memory data) = c.target.call{
                    value: c.value
                }(c.callData);

                // Revert if the call fails and allowFailure is false
                if (!success && !c.allowFailure) {
                    revert CallFailed(data);
                }

                // Store the success status and return data
                returnData[i] = Result({success: success, returnData: data});

                // Emit the CallExecuted event
                emit CallExecuted(digest, c.target, success);
            }
        }
    }

    /// @notice Helper function to hash a CallRequest struct and
    ///         return the EIP-712 digest
    /// @param request The CallRequest struct
    /// @return digest The EIP-712 digest
    function _hashCallRequest(
        CallRequest calldata request
    ) internal view returns (bytes32 digest) {
        // Initialize the array of Call3Value hashes
        bytes32[] memory call3ValuesHashes = new bytes32[](
            request.call3Values.length
        );

        // Iterate over the Call3Values
        for (uint256 i = 0; i < request.call3Values.length; i++) {
            // Hash the Call3Value
            bytes32 call3ValueHash = keccak256(
                abi.encode(
                    _CALL3VALUE_TYPEHASH,
                    request.call3Values[i].target,
                    request.call3Values[i].allowFailure,
                    request.call3Values[i].value,
                    keccak256(request.call3Values[i].callData)
                )
            );

            // Store the hash in the array
            call3ValuesHashes[i] = call3ValueHash;
        }

        // Get the EIP-712 digest to be signed
        digest = _hashTypedData(
            keccak256(
                abi.encode(
                    _CALL_REQUEST_TYPEHASH,
                    keccak256(abi.encodePacked(call3ValuesHashes)),
                    request.nonce
                )
            )
        );
    }

    /// @notice Returns the domain name and version of the contract
    ///         to be used in the domain separator
    /// @return name The domain name
    /// @return version The version
    function _domainNameAndVersion()
        internal
        pure
        override
        returns (string memory name, string memory version)
    {
        name = "CreditMaster";
        version = "1";
    }
}
