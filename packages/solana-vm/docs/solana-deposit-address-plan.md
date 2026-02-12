# Solana Deposit Address Program

## Goal

Add a Solana program that creates unique, deterministic deposit addresses (PDAs) per order ID. Deposit addresses can be computed off-chain before any on-chain transaction. Anyone can call `sweep` to forward deposited funds to the relay depository vault via CPI — pass `mint = Pubkey::default()` for native SOL, or the actual mint for SPL tokens (same pattern as EVM's `address(0)`). An `execute` instruction allows the owner to perform arbitrary CPI from a deposit address for edge cases (stuck funds, airdrops, unsupported tokens), restricted to a dynamic whitelist of allowed programs.

## Architecture

```
User deposits SOL/Token → deterministic PDA (derived from orderId + mint + depositor)
                                ↓
              Anyone calls sweep(id, mint) — mint=default() for native, mint=actual for token
                                ↓
              CPI to relay_depository::deposit_native / deposit_token (branched internally)
                                ↓
              Funds arrive in relay depository vault
```

```
┌─────────────────────────────────────────────────────────┐
│                  deposit_address program                 │
│  - PDA per (orderId, mint, depositor)                   │
│  - sweep(mint) → CPI to depository (native or token)    │
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

Single-file Anchor program with all instructions, accounts, events, and errors. All public items include rustdoc (`///`) comments following the relay-depository convention: instructions have summary + `# Parameters` + `# Returns`, structs/enums have struct-level and field-level docs, and `UncheckedAccount` fields use `/// CHECK:` annotations.

**Program ID**: `CMEh4xH7ercsXoyRC2QFTgqEjECCkkS7oSmj7qvPw8MX`

### 2. Instructions

| Instruction | Access | Description |
|---|---|---|
| `initialize` | `AUTHORIZED_PUBKEY` | Initialize config with relay depository info |
| `set_owner` | owner | Transfer ownership |
| `set_depository` | owner | Update relay depository, program ID, and vault |
| `add_allowed_program` | owner | Add program to execute whitelist |
| `remove_allowed_program` | owner | Remove program from execute whitelist |
| `sweep` | permissionless | Sweep funds from deposit PDA to vault via CPI. `mint=Pubkey::default()` for native SOL, actual mint for tokens. Token-specific accounts are `Option<>` (following `ExecuteTransfer` pattern). Closes ATA after token sweep. |
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

// Deposit address (unified — mint=Pubkey::default() for native SOL)
seeds = ["deposit_address", id, mint.to_bytes(), depositor]

// Allowed program whitelist entry
seeds = ["allowed_program", program_id]
```

**Why `depositor` is in the PDA seeds:** The deposit address contract cannot know who transferred funds into the PDA on-chain. But the depository contract requires the `depositor` when depositing. By including `depositor` in the PDA seeds, Anchor's seed validation enforces that the correct depositor is provided during sweep. Without this, the permissionless sweep caller could pass an arbitrary depositor. The solver/sweeper knows the depositor address off-chain from the order/intent system — the same system that provides `id` and `mint` to derive the deposit address.

### 5. Events

| Event | Emitted by | Fields |
|---|---|---|
| `InitializeEvent` | `initialize` | owner, relay_depository, relay_depository_program, vault |
| `SetOwnerEvent` | `set_owner` | previous_owner, new_owner |
| `SetDepositoryEvent` | `set_depository` | previous/new relay_depository, relay_depository_program, vault |
| `AddAllowedProgramEvent` | `add_allowed_program` | program_id |
| `RemoveAllowedProgramEvent` | `remove_allowed_program` | program_id |
| `SweepEvent` | `sweep` | id, depositor, deposit_address, mint, amount |
| `ExecuteEvent` | `execute` | id, token, depositor, target_program, instruction_data |
| `DepositEvent` | `sweep` (via relay_depository CPI) | id, depositor, amount, token |

### 6. Custom Errors

```rust
error InsufficientBalance    // Deposit address has zero balance
error Unauthorized           // Caller is not the owner / not AUTHORIZED_PUBKEY
error MissingTokenAccounts   // Token-specific accounts required but not provided
```

## Access Control

- `initialize()` — **AUTHORIZED_PUBKEY only** (hardcoded, one-time setup)
- `set_owner()` — **owner only** (transfer ownership)
- `set_depository()` — **owner only** (update relay depository configuration)
- `add_allowed_program()` / `remove_allowed_program()` — **owner only** (manage execute whitelist)
- `sweep()` — **permissionless** (funds always go to config-stored vault via CPI)
- `execute()` — **owner only** (arbitrary CPI, restricted to whitelisted programs)

Since the vault is stored immutably in config and validated via `has_one` constraints, permissionless sweep is safe — there is no way for a caller to redirect funds.

## Key Design Decisions

1. **PDA per (orderId, mint, depositor)** — deterministic addresses computable off-chain before any deposit
2. **Depositor in PDA seeds** — enforces correct depositor attribution since sweep is permissionless
3. **Single `sweep` instruction** — `mint=Pubkey::default()` for native SOL, actual mint for tokens (matches EVM pattern of `address(0)`). Token-specific accounts use `Option<>` following `ExecuteTransfer` pattern in relay-depository
4. **CPI to relay_depository** — sweep forwards funds to vault via existing depository infrastructure, emitting DepositEvent. Internally branches to `deposit_native` or `deposit_token`
5. **No rent-exempt minimum retained** — native sweep transfers full lamport balance (PDA has no data, can be garbage collected)
6. **ATA closed after token sweep** — rent returned to depositor
7. **Dynamic program whitelist** — `execute` restricted to owner-approved programs via PDA-based whitelist
8. **Token2022 support** — uses `TokenInterface` for both SPL Token and Token2022
9. **Config-stored depository** — relay_depository, program ID, and vault stored in config, validated via `has_one` constraints

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

### Sweep

> **Note:** Unlike EVM CREATE2 contracts, Solana PDAs do not need to be "deployed". A PDA address is always valid and can receive SOL at any time without initialization. After a full sweep (0 lamports), the PDA is garbage-collected by the runtime but can immediately receive funds again. No deploy/redeploy distinction exists.

14. Successfully sweep SOL to vault via CPI with mint=Pubkey::default() (+ verify DepositEvent and SweepEvent)
15. Fails when native balance is 0
16. Different IDs produce different deposit addresses
17. Wrong depositor fails PDA seed validation (ConstraintSeeds)
18. Successfully sweep SPL token to vault via CPI (+ verify DepositEvent and SweepEvent, ATA closed, rent returned to depositor)
19. Token2022 support (+ verify DepositEvent and SweepEvent)
20. Fails when token balance is 0
21. Different mints produce different deposit addresses
22. Different depositors produce different deposit addresses
23. Wrong depositor fails PDA seed validation (ConstraintSeeds) for token sweep
24. Token sweep without optional accounts fails (MissingTokenAccounts)
25. Native lifecycle: deposit → sweep → deposit again → sweep again (PDA reusable after full drain)
26. Token lifecycle: deposit → sweep (ATA closed) → create ATA → deposit again → sweep again

### Execute

27. Owner can execute CPI via SystemProgram transfer (+ verify ExecuteEvent)
28. Non-owner cannot execute
29. Wrong token parameter fails PDA seed validation
30. Wrong depositor parameter fails PDA seed validation
31. Owner can execute SPL token transfer
32. Owner can close token account via execute
33. Non-whitelisted program fails (AccountNotInitialized)

## Security Checklist

### Access Control

- [x] `initialize` restricted to `AUTHORIZED_PUBKEY` via constraint
- [x] `set_owner` / `set_depository` restricted to current owner
- [x] `execute` restricted to owner + whitelisted programs
- [x] `sweep` permissionless but funds always go to config-stored vault

### PDA Validation

- [x] Deposit address PDA includes `depositor` in seeds — prevents arbitrary depositor injection
- [x] Config PDA uses `has_one` constraints for relay_depository and vault
- [x] `relay_depository_program` validated via constraint against config
- [x] `allowed_program` PDA existence validates whitelist membership
- [x] `allowed_program.program_id == target_program.key()` explicit constraint — defense-in-depth alongside PDA seed derivation
- [x] `target_program` requires `executable` constraint

### Token Handling

- [x] Token2022 supported via `TokenInterface`
- [x] Zero-balance sweep reverts with `InsufficientBalance`
- [x] ATA closed after token sweep, rent returned to depositor
- [x] `vault_token_account` is `UncheckedAccount` — cannot use `associated_token` constraint because relay_depository may need to create the ATA during CPI. Validation is delegated to the relay_depository program which enforces ATA correctness

### CPI Safety

- [x] `execute` only marks `deposit_address` PDA as signer (not passthrough from remaining_accounts). Caller (owner) is responsible for including deposit_address in remaining_accounts with correct writable/readonly flag depending on the target instruction
- [x] Sweep uses `invoke_signed` with correct PDA seeds and bump

## Verification

```bash
# Build
RUSTUP_TOOLCHAIN=nightly-2025-04-01 anchor build -p deposit_address

# Run tests
RUSTUP_TOOLCHAIN=nightly-2025-04-01 anchor test --skip-lint --skip-build -- --test deposit-address
```

## Status

- [x] Plan reviewed
- [ ] Plan merged
- [x] Contract implemented (7 instructions)
- [x] 33 test cases passing — includes lifecycle tests and `MissingTokenAccounts` test
- [x] Security checklist verified
- [x] Events emitted for all state-changing instructions
