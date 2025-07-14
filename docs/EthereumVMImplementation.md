# Ethereum VM Implementation

## Overview

The EVM implementation provides secure deposit functionality and flexible execution of arbitrary smart contract calls through allocator-signed requests. It leverages EIP-712 structured data signing for secure authorization and supports both native ETH and ERC20 token deposits.

**Source Code**: [/packages/ethereum-vm](/packages/ethereum-vm)

## Architecture

### Core Components
- **Owner**: Administrative control via Ownable pattern
- **Allocator**: Authorized signer for execution requests
- **EIP-712**: Structured data signing for secure authorization
- **Call Execution**: Arbitrary smart contract interaction capability

### Key State Variables
- `mapping(bytes32 => bool) public callRequests`: Replay protection tracking
- `address public allocator`: Authorized signer address

## Functions

### Administrative
- `constructor(owner, allocator)`: Initialize contract with owner and allocator
- `setAllocator(address)`: Update allocator address (owner only)

### Deposits
- `depositNative(depositor, id)`: Deposit ETH with optional depositor override
- `depositErc20(depositor, token, amount, id)`: Deposit specific ERC20 amount
- `depositErc20(depositor, token, id)`: Deposit full allowance amount

### Execution
- `execute(request, signature)`: Execute allocator-signed call requests

CallRequest Structure:
```solidity
struct CallRequest {
    Call[] calls;           // Array of calls to execute
    uint256 nonce;          // Unique identifier
    uint256 expiration;     // Unix timestamp expiration
}

struct Call {
    address to;             // Target contract address
    bytes data;             // Call data
    uint256 value;          // ETH value to send
    bool allowFailure;      // Whether call failure is acceptable
}
```

Events:

RelayNativeDeposit:
```solidity
event RelayNativeDeposit(address from, uint256 amount, bytes32 id);
```

RelayErc20Deposit:
```solidity
event RelayErc20Deposit(address from, address token, uint256 amount, bytes32 id);
```

RelayCallExecuted:
```solidity
event RelayCallExecuted(bytes32 id, Call call);
```