// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EIP712} from "solady/utils/EIP712.sol";

import {BaseTest} from "./BaseTest.t.sol";

import {Call, CallRequest, CallResult} from "../src/utils/RelayDepositoryStructs.sol";
import {RelayDepository} from "../src/RelayDepository.sol";

contract RelayDepositoryTest is BaseTest, EIP712 {
    RelayDepository relayDepository;

    Account allocator = makeAccountAndDeal("allocator", 1 ether);

    // Directly copied from `RelayDepository` / `Ownable`

    error InvalidSignature();
    error Unauthorized();

    event RelayNativeDeposit(address from, uint256 amount, bytes32 id);
    event RelayErc20Deposit(
        address from,
        address token,
        uint256 amount,
        bytes32 id
    );
    event RelayCallExecuted(bytes32 id, Call call);

    bytes32 public constant _CALL_TYPEHASH =
        keccak256(
            "Call(address to,bytes data,uint256 value,bool allowFailure)"
        );
    bytes32 public constant _CALL_REQUEST_TYPEHASH =
        keccak256(
            "CallRequest(Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
        );

    // Setup

    function setUp() public override {
        super.setUp();

        relayDepository = new RelayDepository(address(this), allocator.addr);
    }

    // Tests

    function test_setAllocator() public {
        Account memory newAllocator = makeAccountAndDeal(
            "newAllocator",
            1 ether
        );

        vm.prank(alice.addr);
        vm.expectRevert(Unauthorized.selector);
        relayDepository.setAllocator(newAllocator.addr);

        relayDepository.setAllocator(newAllocator.addr);
        assertEq(relayDepository.allocator(), newAllocator.addr);
    }

    function test_depositNative(uint256 amount) public {
        vm.deal(alice.addr, amount);

        vm.expectEmit(true, true, true, true, address(relayDepository));
        emit RelayNativeDeposit(alice.addr, amount, bytes32(uint256(1)));

        vm.prank(alice.addr);
        relayDepository.depositNative{value: amount}(
            alice.addr,
            bytes32(uint256(1))
        );

        assertEq(address(relayDepository).balance, amount);
    }

    function test_depositErc20(uint96 amount) public {
        erc20.mint(alice.addr, amount);

        vm.prank(alice.addr);
        erc20.approve(address(relayDepository), amount);

        vm.expectEmit(true, true, true, true, address(relayDepository));
        emit RelayErc20Deposit(
            alice.addr,
            address(erc20),
            amount,
            bytes32(uint256(1))
        );

        vm.prank(alice.addr);
        relayDepository.depositErc20(
            alice.addr,
            address(erc20),
            amount,
            bytes32(uint256(1))
        );

        assertEq(erc20.balanceOf(address(relayDepository)), amount);
    }

    function test_depositErc20_usingAllowance(uint96 amount) public {
        erc20.mint(alice.addr, amount);

        vm.prank(alice.addr);
        erc20.approve(address(relayDepository), amount);

        vm.expectEmit(true, true, true, true, address(relayDepository));
        emit RelayErc20Deposit(
            alice.addr,
            address(erc20),
            amount,
            bytes32(uint256(1))
        );

        vm.prank(alice.addr);
        relayDepository.depositErc20(
            alice.addr,
            address(erc20),
            bytes32(uint256(1))
        );

        assertEq(erc20.balanceOf(address(relayDepository)), amount);
    }

    function test_execute_withdrawNative(uint256 amount) public {
        // First, call `test_depositNative`
        test_depositNative(amount);

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            to: alice.addr,
            data: bytes(""),
            value: amount,
            allowFailure: false
        });

        // Create call request
        CallRequest memory request = CallRequest({
            calls: calls,
            nonce: block.prevrandao,
            expiration: block.timestamp + 3600
        });

        // Sign the call request
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            allocator.key,
            _hashCallRequest(request)
        );
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        assertEq(relayDepository.allocator(), allocator.addr);

        uint256 aliceBalanceBefore = address(alice.addr).balance;
        relayDepository.execute(request, signature);
        uint256 aliceBalanceAfter = address(alice.addr).balance;

        assertEq(aliceBalanceAfter - aliceBalanceBefore, amount);
    }

    function test_execute_withdrawErc20(uint96 amount) public {
        // First, call `test_depositErc20`
        test_depositErc20(amount);

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            to: address(erc20),
            data: abi.encodeWithSelector(
                erc20.transfer.selector,
                alice.addr,
                amount
            ),
            value: 0,
            allowFailure: false
        });

        // Create call request
        CallRequest memory request = CallRequest({
            calls: calls,
            nonce: block.prevrandao,
            expiration: block.timestamp + 3600
        });

        // Sign the call request
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            allocator.key,
            _hashCallRequest(request)
        );
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        assertEq(relayDepository.allocator(), allocator.addr);

        uint256 aliceBalanceBefore = erc20.balanceOf(alice.addr);
        relayDepository.execute(request, signature);
        uint256 aliceBalanceAfter = erc20.balanceOf(alice.addr);

        assertEq(aliceBalanceAfter - aliceBalanceBefore, amount);
    }

    function test_execute_withdrawNative_InvalidSignature(
        uint256 amount
    ) public {
        // First, call `test_depositNative`
        test_depositNative(amount);

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            to: alice.addr,
            data: bytes(""),
            value: amount,
            allowFailure: false
        });

        // Create call request
        CallRequest memory request = CallRequest({
            calls: calls,
            nonce: block.prevrandao,
            expiration: block.timestamp + 3600
        });

        // Sign the call request
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            alice.key,
            _hashCallRequest(request)
        );
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        assertEq(relayDepository.allocator(), allocator.addr);

        vm.expectRevert(InvalidSignature.selector);
        relayDepository.execute(request, signature);
    }

    // Utils (copied from `RelayDepository`)

    function _hashCallRequest(
        CallRequest memory request
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
                    request.nonce,
                    request.expiration
                )
            )
        );
    }

    // Overwrite _hashTypedData to use RelayDepository's domain separator
    function _hashTypedData(
        bytes32 structHash
    ) internal view override returns (bytes32 digest) {
        digest = _buildDomainSeparator(address(relayDepository));
        /// @solidity memory-safe-assembly
        assembly {
            mstore(0x00, 0x1901000000000000)
            mstore(0x1a, digest)
            mstore(0x3a, structHash)
            digest := keccak256(0x18, 0x42)
            mstore(0x3a, 0)
        }
    }

    function _buildDomainSeparator(
        address verifyingContract
    ) internal view returns (bytes32 separator) {
        bytes32 versionHash;
        (string memory name, string memory version) = _domainNameAndVersion();
        separator = keccak256(bytes(name));
        versionHash = keccak256(bytes(version));
        /// @solidity memory-safe-assembly
        assembly {
            let m := mload(0x40)
            mstore(m, _DOMAIN_TYPEHASH)
            mstore(add(m, 0x20), separator)
            mstore(add(m, 0x40), versionHash)
            mstore(add(m, 0x60), chainid())
            mstore(add(m, 0x80), verifyingContract)
            separator := keccak256(m, 0xa0)
        }
    }

    function _domainNameAndVersion()
        internal
        pure
        override
        returns (string memory name, string memory version)
    {
        name = "RelayDepository";
        version = "1";
    }
}
