# Sui VM Implementation

## Overview

The Sui implementation of the Relay Depository provides secure deposit and transfer functionality for Sui Coins using Move's strong type system, dynamic fields, and Ed25519 signature verification. It maintains consistent cross-chain behavior while leveraging Sui's unique object-centric model.

**Source Code**: [/packages/sui-vm](/packages/sui-vm)

## Architecture

### Core Components
- **Escrow**: Main shared object storing coins of different types
- **AllocatorCap**: Capability object for administrative functions
- **ExecutedRequests**: Tracks executed withdrawals for replay protection
- **Dynamic Fields**: Type-indexed storage for different coin balances

## Instructions

### Administrative
- `init`: Creates and shares the Escrow and ExecutedRequests objects
- `set_allocator`: Updates the authorized allocator address and public key (requires AllocatorCap)

### Deposits
- `deposit<T>(coin, id)`: Generic deposit function for any Sui coin type
- `deposit_coin<T>(coin, id)`: Entry wrapper for depositing coins

### Execution
- `execute_transfer<T>(request_params, signature)`: Execute allocator-signed transfers

**TransferRequest Structure**:
```rust
public struct TransferRequest has copy, drop {
    recipient: address,    // Destination address
    amount: u64,           // Amount to transfer
    coin_type: TypeName,   // Type of coin to transfer
    nonce: u64,            // Unique nonce
    expiration: u64        // Expiration timestamp
}
```

## Security Features

### Ed25519 Signature Verification
- Validates allocator signatures using Sui's Ed25519 verification module
- Signature covers the hash of the serialized transfer request
- Prevents signature reuse through request tracking

### Protection Mechanisms
- **Replay Protection**: Request hashes stored in ExecutedRequests object
- **Time-based Expiration**: Transfers expire after specified timestamp
- **Object Ownership**: Shared objects control access to funds

## Events

DepositEvent:
```rust
public struct DepositEvent has copy, drop {
    coin_type: TypeName,
    amount: u64,
    from: address,
    deposit_id: vector<u8>,
}
```

TransferExecutedEvent:
```rust
public struct TransferExecutedEvent has copy, drop {
    request_hash: vector<u8>,
    recipient: address,
    amount: u64,
    coin_type: TypeName,
}
```

AllocatorChangedEvent:
```rust
public struct AllocatorChangedEvent has copy, drop {
    old_allocator: address,
    new_allocator: address
}
```

### View Functions
- `get_allocator`: Returns current allocator address and public key
- `get_balance<T>`: Returns balance of specific coin type
- `check_request_executed`: Checks if a request has been executed

### Token Support
- Native SUI coin
- Any custom coin type