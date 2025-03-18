// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test} from "forge-std/Test.sol";
import {EIP712} from "solady/utils/EIP712.sol";

import {BaseTest} from "./BaseTest.t.sol";
import {Call, CallRequest, CallResult} from "../src/utils/RelayEscrowStructs.sol";

contract RelayEscrowTest is BaseTest, EIP712 {
    RelayEscrow relayEscrow;

    Account allocator = makeAccountAndDeal("allocator", 1 ether);

    // Directly copied from `RelayEscrow`

    event NativeDeposit(address from, uint256 amount, bytes32 id);
    event Erc20Deposit(address from, address token, uint256 amount, bytes32 id);
    event CallRequestExecuted(bytes32 id, Call[] calls, CallResult[] results);

    bytes32 public constant _CALL_TYPEHASH =
        keccak256(
            "Call(address to,bytes data,uint256 value,bool allowFailure)"
        );
    bytes32 public constant _CALL_REQUEST_TYPEHASH =
        keccak256(
            "CallRequest(Call[] calls,uint256 nonce,uint256 expiration)Call(address to,bytes data,uint256 value,bool allowFailure)"
        );

    bytes32 public constant DOMAIN_SEPARATOR =
        0x51fa773305558637d491860150e2b93d8f98be7fefefb6f2313f98ec2e9ae8d2;

    function setUp() public override {
        super.setUp();

        relayEscrow = new RelayEscrow(allocator.addr);
    }

    function testDepositEth(uint256 amount) public {
        vm.deal(alice.addr, amount);

        vm.expectEmit(true, true, true, true, address(cm));
        emit Deposit(alice.addr, address(0), amount, bytes32(uint256(1)));

        vm.prank(alice.addr);
        cm.depositNative{value: amount}(alice.addr, bytes32(uint256(1)));
        assertEq(address(cm).balance, amount);
    }

    function testDepositErc20(uint96 amount) public {
        erc20_1.mint(alice.addr, amount);

        vm.startPrank(alice.addr);

        // Alice approves CM to pull tokens
        IERC20(address(erc20_1)).approve(address(cm), amount);

        vm.expectEmit(true, true, true, true, address(cm));
        emit Deposit(alice.addr, address(erc20_1), amount, bytes32(uint256(1)));

        // Alice deposits ERC20s to CM
        cm.depositErc20(
            alice.addr,
            address(erc20_1),
            amount,
            bytes32(uint256(1))
        );
    }

    function testSetAllocator() public {
        Account memory newAllocator = makeAccountAndDeal(
            "newAllocator",
            1 ether
        );

        vm.prank(alice.addr);
        vm.expectRevert(Unauthorized.selector);
        cm.setAllocator(newAllocator.addr);

        cm.setAllocator(newAllocator.addr);
        assertEq(cm.allocator(), newAllocator.addr);
    }

    function testExecute__WithdrawNative(uint256 amount) public {
        // Run depositNative test
        testDepositEth(amount);

        Call3Value[] memory calls = new Call3Value[](1);
        calls[0] = Call3Value({
            target: alice.addr,
            allowFailure: false,
            value: amount,
            callData: bytes("")
        });

        // Create call request
        CallRequest memory request = CallRequest({
            call3Values: calls,
            nonce: 1
        });

        bytes32 digest = _hashCallRequest(request);

        // Sign request
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(allocator.key, digest);
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        assertEq(cm.allocator(), allocator.addr);

        // vm.expectEmit(true, true, true, true, address(cm));
        // emit CallRequestExecuted(digest);

        // Call `withdraw`
        uint256 aliceBalanceBefore = address(alice.addr).balance;
        vm.prank(alice.addr);
        cm.execute(request, signature);
        uint256 aliceBalanceAfter = address(alice.addr).balance;

        assertEq(aliceBalanceAfter - aliceBalanceBefore, amount);
    }

    function testExecute__WithdrawERC20(uint96 amount) public {
        testDepositErc20(amount);

        // Create withdraw request
        Call3Value[] memory calls = new Call3Value[](1);
        calls[0] = Call3Value({
            target: address(erc20_1),
            allowFailure: false,
            value: 0,
            callData: abi.encodeWithSelector(
                erc20_1.transfer.selector,
                alice.addr,
                amount
            )
        });
        CallRequest memory request = CallRequest({
            call3Values: calls,
            nonce: 1
        });

        bytes32 digest = _hashCallRequest(request);

        // Sign request
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(allocator.key, digest);
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        assertEq(cm.allocator(), allocator.addr);

        vm.expectEmit(true, true, true, true, address(cm));
        emit CallExecuted(digest, address(erc20_1), true);

        // Call `withdraw`
        uint256 aliceBalanceBefore = erc20_1.balanceOf(alice.addr);
        cm.execute(request, signature);
        uint256 aliceBalanceAfter = erc20_1.balanceOf(alice.addr);

        assertEq(aliceBalanceAfter - aliceBalanceBefore, amount);
    }

    function testExecute__WithdrawNative__RevertInvalidSignature(
        uint256 amount
    ) public {
        // Create withdraw request
        Call3Value[] memory calls = new Call3Value[](1);
        calls[0] = Call3Value({
            target: address(erc20_1),
            allowFailure: false,
            value: 0,
            callData: abi.encodeWithSelector(
                erc20_1.transfer.selector,
                alice.addr,
                amount
            )
        });
        CallRequest memory request = CallRequest({
            call3Values: calls,
            nonce: 1
        });

        bytes32 digest = _hashCallRequest(request);

        // Sign request with alice's key
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alice.key, digest);
        bytes memory signature = bytes.concat(r, s, bytes1(v));

        assertEq(cm.allocator(), allocator.addr);

        vm.expectRevert(InvalidSignature.selector);
        cm.execute(request, signature);
    }

    function _hashCallRequest(
        CallRequest memory request
    ) internal returns (bytes32 digest) {
        bytes32[] memory call3ValuesHashes = new bytes32[](
            request.call3Values.length
        );

        // Hash the call3Values
        for (uint256 i = 0; i < request.call3Values.length; i++) {
            bytes32 call3ValueHash = keccak256(
                abi.encode(
                    _CALL3VALUE_TYPEHASH,
                    request.call3Values[i].target,
                    request.call3Values[i].allowFailure,
                    request.call3Values[i].value,
                    keccak256(request.call3Values[i].callData)
                )
            );

            call3ValuesHashes[i] = call3ValueHash;
        }

        // Get the EIP-712 digest to be signed
        bytes32 structHash = keccak256(
            abi.encode(
                _CALL_REQUEST_TYPEHASH,
                keccak256(abi.encodePacked(call3ValuesHashes)),
                request.nonce
            )
        );

        digest = _hashTypedData(structHash);
    }

    // Overwrite _hashTypedData to use CreditMaster's domain separator
    function _hashTypedData(
        bytes32 structHash
    ) internal view override returns (bytes32 digest) {
        digest = _buildDomainSeparator(address(cm));
        /// @solidity memory-safe-assembly
        assembly {
            // Compute the digest.
            mstore(0x00, 0x1901000000000000) // Store "\x19\x01".
            mstore(0x1a, digest) // Store the domain separator.
            mstore(0x3a, structHash) // Store the struct hash.
            digest := keccak256(0x18, 0x42)
            // Restore the part of the free memory slot that was overwritten.
            mstore(0x3a, 0)
        }
    }

    function _domainNameAndVersion()
        internal
        pure
        override
        returns (string memory name, string memory version)
    {
        name = "CreditMaster";
        version = "1";
    }

    function _buildDomainSeparator(
        address cmAddress
    ) internal view returns (bytes32 separator) {
        bytes32 versionHash;
        (string memory name, string memory version) = _domainNameAndVersion();
        separator = keccak256(bytes(name));
        versionHash = keccak256(bytes(version));
        /// @solidity memory-safe-assembly
        assembly {
            let m := mload(0x40) // Load the free memory pointer.
            mstore(m, _DOMAIN_TYPEHASH)
            mstore(add(m, 0x20), separator) // Name hash.
            mstore(add(m, 0x40), versionHash)
            mstore(add(m, 0x60), chainid())
            mstore(add(m, 0x80), cmAddress)
            separator := keccak256(m, 0xa0)
        }
    }
}
