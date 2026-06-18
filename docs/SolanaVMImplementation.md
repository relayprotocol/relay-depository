# Solana VM Implementation

## Overview

The Solana implementation provides secure deposit and transfer functionality for native SOL and SPL tokens using Program Derived Addresses (PDAs) and Ed25519 signature verification.

**Source Code**: [/packages/solana-vm](/packages/solana-vm)

## Architecture

### Core Components
- **RelayDepository**: Main state (owner, allocator, vault_bump)
- **Vault PDA**: Secure SOL custody (`seeds = ["vault"]`)
- **UsedRequest**: Replay protection tracking
- **Vault Token Accounts**: SPL token storage via ATAs

## Instructions

### Administrative
- `initialize`: Setup program with owner and allocator
- `set_allocator` / `set_owner`: Update authorized addresses (owner only)

### Deposits
- `deposit_native(amount, id)`: Deposit SOL to vault PDA
- `deposit_token(amount, id)`: Deposit SPL tokens with automatic ATA creation

### Execution
- `execute_transfer(request)`: Execute allocator-signed transfers

**TransferRequest Structure**:
```rust
pub struct TransferRequest {
    pub recipient: Pubkey,
    pub token: Option<Pubkey>,  // None for SOL, Some(mint) for SPL
    pub amount: u64,
    pub nonce: u64,
    pub expiration: i64,
}
```

## Security Features

### Ed25519 Signature Verification
- Validates allocator signatures using Solana's Ed25519 program
- Verifies message hash matches transfer request
- Prevents signature reuse

### Protection Mechanisms
- **Replay Protection**: Request hashes stored in UsedRequest PDAs
- **Rent Protection**: Maintains vault rent-exempt balance for SOL transfers
- **Token Fee Handling**: Automatic Token-2022 transfer fee calculation
- **Expiration Control**: Time-based request validity

## Events

DepositEvent:
```rust
pub struct DepositEvent {
    pub depositor: Pubkey,
    pub token: Option<Pubkey>,
    pub amount: u64,            // Net amount after fees
    pub id: [u8; 32],
}
```

TransferExecutedEvent:
```rust
pub struct TransferExecutedEvent {
    pub request: TransferRequest,
    pub executor: Pubkey,
    pub id: Pubkey,
}
```

### Token Support
- Native SOL transfers
- Legacy SPL tokens
- Token-2022 with transfer fees