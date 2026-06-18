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

    // ============ Additional Tests ============

    error AddressCannotBeZero();
    error CallRequestExpired();
    error CallRequestAlreadyUsed();
    error CallFailed(bytes returnData);

    function test_setAllocator_zeroAddress() public {
        vm.expectRevert(AddressCannotBeZero.selector);
        relayDepository.setAllocator(address(0));
    }

    function test_execute_expired() public {
        vm.deal(alice.addr, 1 ether);
        vm.prank(alice.addr);
        relayDepository.depositNative{value: 1 ether}(alice.addr, bytes32(uint256(1)));

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            to: alice.addr,
            data: bytes(""),
            value: 1 ether,
            allowFailure: false
        });

        // Create call request with expired timestamp
        CallRequest memory request = CallRequest({
            calls: calls,
            nonce: block.prevrandao,
            expiration: block.timestamp - 1 // Already expired
        });

        // Sign the call request
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            allocator.key,
            _hashCallRequest(request)
        );
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        vm.expectRevert(CallRequestExpired.selector);
        relayDepository.execute(request, signature);
    }

    function test_execute_alreadyUsed() public {
        vm.deal(alice.addr, 2 ether);
        vm.prank(alice.addr);
        relayDepository.depositNative{value: 2 ether}(alice.addr, bytes32(uint256(1)));

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            to: alice.addr,
            data: bytes(""),
            value: 1 ether,
            allowFailure: false
        });

        CallRequest memory request = CallRequest({
            calls: calls,
            nonce: 12345, // Fixed nonce for replay
            expiration: block.timestamp + 3600
        });

        // Sign the call request
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            allocator.key,
            _hashCallRequest(request)
        );
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        // First execution should succeed
        relayDepository.execute(request, signature);

        // Second execution should fail with CallRequestAlreadyUsed
        vm.expectRevert(CallRequestAlreadyUsed.selector);
        relayDepository.execute(request, signature);
    }

    function test_execute_callFailed() public {
        vm.deal(alice.addr, 1 ether);
        vm.prank(alice.addr);
        relayDepository.depositNative{value: 1 ether}(alice.addr, bytes32(uint256(1)));

        Call[] memory calls = new Call[](1);
        // Try to call a contract that will revert
        calls[0] = Call({
            to: address(erc20),
            data: abi.encodeWithSelector(erc20.transfer.selector, alice.addr, 1000 ether), // More than balance
            value: 0,
            allowFailure: false // Should revert
        });

        CallRequest memory request = CallRequest({
            calls: calls,
            nonce: block.prevrandao,
            expiration: block.timestamp + 3600
        });

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            allocator.key,
            _hashCallRequest(request)
        );
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        vm.expectRevert(); // CallFailed with return data
        relayDepository.execute(request, signature);
    }

    function test_execute_allowFailure() public {
        vm.deal(alice.addr, 1 ether);
        vm.prank(alice.addr);
        relayDepository.depositNative{value: 1 ether}(alice.addr, bytes32(uint256(1)));

        Call[] memory calls = new Call[](2);
        // First call will fail but allowFailure is true
        calls[0] = Call({
            to: address(erc20),
            data: abi.encodeWithSelector(erc20.transfer.selector, alice.addr, 1000 ether), // Will fail
            value: 0,
            allowFailure: true // Should NOT revert
        });
        // Second call should succeed
        calls[1] = Call({
            to: alice.addr,
            data: bytes(""),
            value: 0.5 ether,
            allowFailure: false
        });

        CallRequest memory request = CallRequest({
            calls: calls,
            nonce: block.prevrandao,
            expiration: block.timestamp + 3600
        });

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            allocator.key,
            _hashCallRequest(request)
        );
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        uint256 aliceBalanceBefore = address(alice.addr).balance;
        CallResult[] memory results = relayDepository.execute(request, signature);
        uint256 aliceBalanceAfter = address(alice.addr).balance;

        // First call should have failed
        assertFalse(results[0].success);
        // Second call should have succeeded
        assertTrue(results[1].success);
        // Alice should have received 0.5 ether
        assertEq(aliceBalanceAfter - aliceBalanceBefore, 0.5 ether);
    }

    function test_depositNative_zeroDepositor() public {
        vm.deal(alice.addr, 1 ether);

        // When depositor is address(0), msg.sender should be used
        vm.expectEmit(true, true, true, true, address(relayDepository));
        emit RelayNativeDeposit(alice.addr, 1 ether, bytes32(uint256(1)));

        vm.prank(alice.addr);
        relayDepository.depositNative{value: 1 ether}(
            address(0), // Zero address - should use msg.sender
            bytes32(uint256(1))
        );
    }

    function test_depositErc20_zeroDepositor() public {
        erc20.mint(alice.addr, 1 ether);

        vm.prank(alice.addr);
        erc20.approve(address(relayDepository), 1 ether);

        // When depositor is address(0), msg.sender should be used
        vm.expectEmit(true, true, true, true, address(relayDepository));
        emit RelayErc20Deposit(alice.addr, address(erc20), 1 ether, bytes32(uint256(1)));

        vm.prank(alice.addr);
        relayDepository.depositErc20(
            address(0), // Zero address - should use msg.sender
            address(erc20),
            1 ether,
            bytes32(uint256(1))
        );
    }

    function test_execute_multipleCalls() public {
        // Setup: deposit native and ERC20
        vm.deal(alice.addr, 2 ether);
        vm.prank(alice.addr);
        relayDepository.depositNative{value: 2 ether}(alice.addr, bytes32(uint256(1)));

        erc20.mint(address(relayDepository), 100 ether);

        Call[] memory calls = new Call[](3);
        // Call 1: Send native to alice
        calls[0] = Call({
            to: alice.addr,
            data: bytes(""),
            value: 1 ether,
            allowFailure: false
        });
        // Call 2: Send ERC20 to bob
        calls[1] = Call({
            to: address(erc20),
            data: abi.encodeWithSelector(erc20.transfer.selector, bob.addr, 50 ether),
            value: 0,
            allowFailure: false
        });
        // Call 3: Send native to bob
        calls[2] = Call({
            to: bob.addr,
            data: bytes(""),
            value: 0.5 ether,
            allowFailure: false
        });

        CallRequest memory request = CallRequest({
            calls: calls,
            nonce: block.prevrandao,
            expiration: block.timestamp + 3600
        });

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            allocator.key,
            _hashCallRequest(request)
        );
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        uint256 aliceNativeBefore = address(alice.addr).balance;
        uint256 bobNativeBefore = address(bob.addr).balance;
        uint256 bobErc20Before = erc20.balanceOf(bob.addr);

        CallResult[] memory results = relayDepository.execute(request, signature);

        // All calls should succeed
        assertTrue(results[0].success);
        assertTrue(results[1].success);
        assertTrue(results[2].success);

        // Verify balances
        assertEq(address(alice.addr).balance - aliceNativeBefore, 1 ether);
        assertEq(address(bob.addr).balance - bobNativeBefore, 0.5 ether);
        assertEq(erc20.balanceOf(bob.addr) - bobErc20Before, 50 ether);
    }

    function test_transferOwnership() public {
        // Initial owner is address(this)
        assertEq(relayDepository.owner(), address(this));

        // Transfer ownership to alice
        relayDepository.transferOwnership(alice.addr);
        assertEq(relayDepository.owner(), alice.addr);

        // Old owner should not be able to set allocator
        vm.expectRevert(Unauthorized.selector);
        relayDepository.setAllocator(bob.addr);

        // New owner should be able to set allocator
        vm.prank(alice.addr);
        relayDepository.setAllocator(bob.addr);
        assertEq(relayDepository.allocator(), bob.addr);
    }

    function test_renounceOwnership() public {
        // Renounce ownership
        relayDepository.renounceOwnership();
        assertEq(relayDepository.owner(), address(0));

        // No one should be able to set allocator
        vm.expectRevert(Unauthorized.selector);
        relayDepository.setAllocator(bob.addr);

        vm.prank(alice.addr);
        vm.expectRevert(Unauthorized.selector);
        relayDepository.setAllocator(bob.addr);
    }

    function test_depositErc20_insufficientBalance() public {
        // Alice has no tokens
        vm.prank(alice.addr);
        erc20.approve(address(relayDepository), 1 ether);

        vm.expectRevert();
        vm.prank(alice.addr);
        relayDepository.depositErc20(
            alice.addr,
            address(erc20),
            1 ether,
            bytes32(uint256(1))
        );
    }

    function test_depositErc20_insufficientAllowance() public {
        erc20.mint(alice.addr, 1 ether);

        // Approve less than deposit amount
        vm.prank(alice.addr);
        erc20.approve(address(relayDepository), 0.5 ether);

        vm.expectRevert();
        vm.prank(alice.addr);
        relayDepository.depositErc20(
            alice.addr,
            address(erc20),
            1 ether,
            bytes32(uint256(1))
        );
    }

    function test_execute_insufficientBalance() public {
        // Deposit only 0.5 ether
        vm.deal(alice.addr, 0.5 ether);
        vm.prank(alice.addr);
        relayDepository.depositNative{value: 0.5 ether}(alice.addr, bytes32(uint256(1)));

        Call[] memory calls = new Call[](1);
        calls[0] = Call({
            to: alice.addr,
            data: bytes(""),
            value: 1 ether, // More than deposited
            allowFailure: false
        });

        CallRequest memory request = CallRequest({
            calls: calls,
            nonce: block.prevrandao,
            expiration: block.timestamp + 3600
        });

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            allocator.key,
            _hashCallRequest(request)
        );
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        vm.expectRevert(); // Should fail due to insufficient balance
        relayDepository.execute(request, signature);
    }

    function test_execute_emptyCallsArray() public {
        Call[] memory calls = new Call[](0);

        CallRequest memory request = CallRequest({
            calls: calls,
            nonce: block.prevrandao,
            expiration: block.timestamp + 3600
        });

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            allocator.key,
            _hashCallRequest(request)
        );
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        // Should succeed with empty results
        CallResult[] memory results = relayDepository.execute(request, signature);
        assertEq(results.length, 0);
    }

    function test_depositNative_differentDepositor() public {
        vm.deal(alice.addr, 1 ether);

        // Alice deposits but credits bob
        vm.expectEmit(true, true, true, true, address(relayDepository));
        emit RelayNativeDeposit(bob.addr, 1 ether, bytes32(uint256(1)));

        vm.prank(alice.addr);
        relayDepository.depositNative{value: 1 ether}(
            bob.addr, // Credit to bob
            bytes32(uint256(1))
        );

        assertEq(address(relayDepository).balance, 1 ether);
    }

    function test_depositErc20_differentDepositor() public {
        erc20.mint(alice.addr, 1 ether);

        vm.prank(alice.addr);
        erc20.approve(address(relayDepository), 1 ether);

        // Alice deposits but credits bob
        vm.expectEmit(true, true, true, true, address(relayDepository));
        emit RelayErc20Deposit(bob.addr, address(erc20), 1 ether, bytes32(uint256(1)));

        vm.prank(alice.addr);
        relayDepository.depositErc20(
            bob.addr, // Credit to bob
            address(erc20),
            1 ether,
            bytes32(uint256(1))
        );

        assertEq(erc20.balanceOf(address(relayDepository)), 1 ether);
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
