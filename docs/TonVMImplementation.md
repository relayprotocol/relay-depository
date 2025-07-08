# TON VM Implementation

## Overview

The TON implementation of the Relay Depository provides secure deposit and transfer functionality for native TON coins and Jetton tokens using FunC smart contracts with rigorous signature verification and event logging. The implementation adapts to TON's asynchronous messaging model while maintaining the core protocol functionality.

**Source Code**: [/packages/ton-vm](/packages/ton-vm)

## Architecture

### Core Components
- **Main Contract**: Stores configuration and processes transactions
- **Event Logging**: Emits transaction events through outgoing messages
- **Storage Variables**: Persistent contract state (owner, allocator, nonce)

## Instructions

### Administrative
- `op::set_allocator`: Updates the authorized allocator address (owner only)

### Deposits
- **TON deposits**: Either direct transfers or via `op::deposit` operation
- **Jetton deposits**: Handled via `op::transfer_notification` callbacks

### Execution
- `op::transfers`: Processes batch transfers with allocator signatures

**TransferRequest Structure**:
```
msg_nonce: uint64       // Unique nonce for replay protection
expiry: uint32          // UNIX timestamp for validity
currency_type: uint8    // 0=TON, 1=Jetton
to_addr: MsgAddress     // Recipient address
jetton_wallet: MsgAddress // Contract's jetton wallet for this token
currency_addr: MsgAddress // Token address (or empty for TON)
amount: Coins           // Amount to transfer
forward_amount: Coins   // Forward amount for recipient
gas_amount: Coins       // Gas for processing
signature: bits512      // Ed25519 signature by allocator
```

## Security Features

### Ed25519 Signature Verification
- Validates allocator signatures using TON's native check_signature
- Signature covers the hash of a cell containing transfer parameters
- Maintains strict nonce progression for replay protection

### Protection Mechanisms
- **Replay Protection**: Strict nonce ordering with incremental validation
- **Time-based Expiration**: Transfers expire after specified timestamp
- **Balance Checks**: Validates sufficient TON balance before transfers
- **Operation Authorization**: Owner-only administrative functions

## Events

DepositEvent:
```
event_id: uint32 = 0x88879a49
asset_type: uint1 // 0=TON, 1=Jetton
wallet: MsgAddress // Contract or jetton wallet address
amount: Coins // Transfer amount
depositor: MsgAddress // Sender address
id: uint64 // Optional deposit ID
```

TransferEvent:
```
event_id: uint32 = 0x5c87ae7e
currency: MsgAddress // Asset address or empty for TON
amount: Coins // Transfer amount
msg_hash: uint256 // Hash of the signed message
```

### Get Methods
- `get_owner()`: Returns owner address
- `get_allocator()`: Returns allocator address
- `get_nonce()`: Returns current nonce value

### Token Support
- Native TON coins
- Any TON Jetton token (TEP-74 standard)