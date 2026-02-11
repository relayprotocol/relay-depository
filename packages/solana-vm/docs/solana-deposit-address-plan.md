# Solana Deposit Address Program

## Goal

Add a Solana program that creates unique, deterministic deposit addresses (PDAs) per order ID. Deposit addresses can be computed off-chain before any on-chain transaction. Anyone can call `sweep_native` / `sweep_token` to forward deposited funds to the relay depository vault via CPI. An `execute` instruction allows the owner to perform arbitrary CPI from a deposit address for edge cases (stuck funds, airdrops, unsupported tokens), restricted to a dynamic whitelist of allowed programs.

## Architecture

```
User deposits SOL/Token → deterministic PDA (derived from orderId + token + depositor)
                                ↓
              Anyone calls sweep_native / sweep_token
                                ↓
              CPI to relay_depository::deposit_native / deposit_token
                                ↓
              Funds arrive in relay depository vault
```

```
┌─────────────────────────────────────────────────────────┐
│                  deposit_address program                 │
│  - PDA per (orderId, token, depositor)                  │
│  - sweep_native / sweep_token → CPI to depository       │
│  - execute → arbitrary CPI (owner-only, whitelisted)    │
└───────────────────────┬─────────────────────────────────┘
                        │ CPI (PDA signs via invoke_signed)
                        ▼
┌─────────────────────────────────────────────────────────┐
│               relay_depository program                   │
│  - deposit_native / deposit_token → vault               │
│  - Emits DepositEvent                                    │
└─────────────────────────────────────────────────────────┘
```

## Implementation

### 1. deposit-address program (`lib.rs`)

Single-file Anchor program with all instructions, accounts, events, and errors.

**Program ID**: `CMEh4xH7ercsXoyRC2QFTgqEjECCkkS7oSmj7qvPw8MX`

### 2. Instructions

| Instruction | Access | Description |
|---|---|---|
| `initialize` | `AUTHORIZED_PUBKEY` | Initialize config with relay depository info |
| `set_owner` | owner | Transfer ownership |
| `set_depository` | owner | Update relay depository, program ID, and vault |
| `add_allowed_program` | owner | Add program to execute whitelist |
| `remove_allowed_program` | owner | Remove program from execute whitelist |
| `sweep_native` | permissionless | Sweep full SOL balance from deposit PDA to vault via CPI |
| `sweep_token` | permissionless | Sweep token balance from deposit PDA to vault via CPI, close ATA |
| `execute` | owner | Execute arbitrary CPI from deposit PDA (whitelisted programs only) |

### 3. Account Structures

| Account | Seeds | Size | Description |
|---|---|---|---|
| `DepositAddressConfig` | `["config"]` | 8 + 128 (4 Pubkeys) | Stores owner, relay_depository, relay_depository_program, vault |
| `AllowedProgram` | `["allowed_program", program_id]` | 8 + 32 | Whitelist entry for execute |

### 4. PDA Seeds

```
// Config account
seeds = ["config"]

// Deposit address (SOL)
seeds = ["deposit_address", id, Pubkey::default().to_bytes(), depositor]

// Deposit address (Token)
seeds = ["deposit_address", id, mint.to_bytes(), depositor]

// Allowed program whitelist entry
seeds = ["allowed_program", program_id]
```

**Why `depositor` is in the PDA seeds:** The deposit address contract cannot know who transferred funds into the PDA on-chain. But the depository contract requires the `depositor` when depositing. By including `depositor` in the PDA seeds, Anchor's seed validation enforces that the correct depositor is provided during sweep. Without this, the permissionless sweep caller could pass an arbitrary depositor.

### 5. Events

| Event | Emitted by | Fields |
|---|---|---|
| `InitializeEvent` | `initialize` | owner, relay_depository, relay_depository_program, vault |
| `SetOwnerEvent` | `set_owner` | previous_owner, new_owner |
| `SetDepositoryEvent` | `set_depository` | previous/new relay_depository, relay_depository_program, vault |
| `AddAllowedProgramEvent` | `add_allowed_program` | program_id |
| `RemoveAllowedProgramEvent` | `remove_allowed_program` | program_id |
| `SweepNativeEvent` | `sweep_native` | id, depositor, deposit_address, amount |
| `SweepTokenEvent` | `sweep_token` | id, depositor, deposit_address, mint, amount |
| `ExecuteEvent` | `execute` | id, token, depositor, target_program, instruction_data |
| `DepositEvent` | `sweep_*` (via relay_depository CPI) | id, depositor, amount, token |

### 6. Custom Errors

```rust
error InsufficientBalance  // Deposit address has zero balance
error Unauthorized          // Caller is not the owner / not AUTHORIZED_PUBKEY
```

## Access Control

- `initialize()` — **AUTHORIZED_PUBKEY only** (hardcoded, one-time setup)
- `set_owner()` — **owner only** (transfer ownership)
- `set_depository()` — **owner only** (update relay depository configuration)
- `add_allowed_program()` / `remove_allowed_program()` — **owner only** (manage execute whitelist)
- `sweep_native()` / `sweep_token()` — **permissionless** (funds always go to hardcoded vault via CPI)
- `execute()` — **owner only** (arbitrary CPI, restricted to whitelisted programs)

Since the vault is stored immutably in config and validated via `has_one` constraints, permissionless sweep is safe — there is no way for a caller to redirect funds.

## Key Design Decisions

1. **PDA per (orderId, token, depositor)** — deterministic addresses computable off-chain before any deposit
2. **Depositor in PDA seeds** — enforces correct depositor attribution since sweep is permissionless
3. **CPI to relay_depository** — sweep forwards funds to vault via existing depository infrastructure, emitting DepositEvent
4. **No rent-exempt minimum retained** — `sweep_native` transfers full lamport balance (PDA has no data, can be garbage collected)
5. **ATA closed after token sweep** — rent returned to depositor
6. **Dynamic program whitelist** — `execute` restricted to owner-approved programs via PDA-based whitelist
7. **Token2022 support** — uses `TokenInterface` for both SPL Token and Token2022
8. **Config-stored depository** — relay_depository, program ID, and vault stored in config, validated via `has_one` constraints

## Files

```
packages/solana-vm/
├── programs/deposit-address/
│   ├── Cargo.toml
│   ├── Xargo.toml
│   └── src/
│       └── lib.rs
└── tests/
    └── deposit-address.ts
```

## Stack

- **Anchor 0.30.1** — Solana program framework
- **Solana 1.16** — runtime
- **Rust nightly-2025-04-01** — compiler toolchain
- **Mocha/Chai** — test framework
- **TypeScript** — test language

## Dependencies

```toml
[dependencies]
anchor-lang = "0.30.1"
anchor-spl = "0.30.1"
solana-program = "1.16"
relay-depository = { path = "../relay-depository", features = ["cpi"] }
```

## Test Cases

### Admin

1. Unauthorized user (not AUTHORIZED_PUBKEY) cannot initialize
2. Successfully initialize configuration (+ verify InitializeEvent)
3. Re-initialization fails (account already exists)
4. Non-owner cannot transfer ownership
5. Owner can transfer ownership (+ verify SetOwnerEvent)
6. Non-owner cannot update depository configuration
7. Owner can update depository configuration (+ verify SetDepositoryEvent)

### Whitelist

8. Owner can add program to whitelist (+ verify AddAllowedProgramEvent)
9. Non-owner cannot add program to whitelist
10. Owner can add TOKEN_PROGRAM_ID to whitelist
11. Duplicate program addition fails (PDA already exists)
12. Owner can remove program from whitelist (+ verify RemoveAllowedProgramEvent)
13. Non-owner cannot remove program from whitelist

### Sweep Native

14. Successfully sweep SOL to vault via CPI (+ verify DepositEvent and SweepNativeEvent)
15. Fails when balance is 0
16. Different IDs produce different deposit addresses
17. Wrong depositor fails PDA seed validation (ConstraintSeeds)

### Sweep Token

18. Successfully sweep SPL token to vault via CPI (+ verify DepositEvent and SweepTokenEvent, ATA closed, rent returned to depositor)
19. Token2022 support (+ verify DepositEvent and SweepTokenEvent)
20. Fails when balance is 0
21. Different mints produce different deposit addresses
22. Different depositors produce different deposit addresses
23. Wrong depositor fails PDA seed validation (ConstraintSeeds)

### Execute

24. Owner can execute CPI via SystemProgram transfer (+ verify ExecuteEvent)
25. Non-owner cannot execute
26. Wrong token parameter fails PDA seed validation
27. Wrong depositor parameter fails PDA seed validation
28. Owner can execute SPL token transfer
29. Owner can close token account via execute
30. Non-whitelisted program fails (AccountNotInitialized)

## Security Checklist

### Access Control

- [x] `initialize` restricted to `AUTHORIZED_PUBKEY` via constraint
- [x] `set_owner` / `set_depository` restricted to current owner
- [x] `execute` restricted to owner + whitelisted programs
- [x] `sweep_*` permissionless but funds always go to config-stored vault

### PDA Validation

- [x] Deposit address PDA includes `depositor` in seeds — prevents arbitrary depositor injection
- [x] Config PDA uses `has_one` constraints for relay_depository and vault
- [x] `relay_depository_program` validated via constraint against config
- [x] `allowed_program` PDA existence validates whitelist membership
- [x] `target_program` requires `executable` constraint

### Token Handling

- [x] Token2022 supported via `TokenInterface`
- [x] Zero-balance sweep reverts with `InsufficientBalance`
- [x] ATA closed after token sweep, rent returned to depositor

### CPI Safety

- [x] `execute` only marks `deposit_address` PDA as signer (not passthrough from remaining_accounts)
- [x] Sweep uses `invoke_signed` with correct PDA seeds and bump

## Verification

```bash
# Build
RUSTUP_TOOLCHAIN=nightly-2025-04-01 anchor build -p deposit_address

# Run tests
RUSTUP_TOOLCHAIN=nightly-2025-04-01 anchor test --skip-lint --skip-build -- --test deposit-address
```

## Status

- [x] Full contract implemented (8 instructions)
- [x] 30 test cases passing (70 total including relay-depository and relay-forwarder)
- [x] Security review completed
- [x] Events emitted for all state-changing instructions
