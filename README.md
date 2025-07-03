# Relay Depository

## Overview

The Relay Depository is a cross-chain protocol that securely manages user deposits and enables controlled withdrawals through a trusted allocator mechanism. It acts as a financial coordination layer across multiple blockchain environments, with implementations for Ethereum Virtual Machine (EVM) chains, Solana, Sui, and TON.

At its core, the Relay Depository provides two fundamental operations:

1. **Deposits**: Users can deposit native currencies or tokens into the depository. Each deposit is associated with an ID that links to an intended action or purpose.

2. **Withdrawals**: An authorized allocator can sign withdrawal requests to transfer funds from the depository. These withdrawals are executed as on-chain transactions verified against the allocator's cryptographic signature.

The protocol maintains consistent behavior across all blockchain environments while adapting to each platform's specific features and security models:

- [Ethereum VM Implementation](./docs/EthereumVMImplementation.md)
- [Solana VM Implementation](./docs/SolanaVMImplementation.md)

## How It Works

The workflow of the Relay Depository follows this pattern:

1. A user deposits funds into the depository contract with an ID
2. The deposit is recorded on-chain with an event
3. Off-chain systems process deposits and prepare execution requests
4. The allocator signs withdrawal requests specifying recipients and amounts
5. Anyone can execute the withdrawal requests on-chain, transferring funds from the depository
6. Each executed withdrawal is recorded on-chain with an event for attestation and tracking

## Security

The Relay Depository contracts have undergone comprehensive security audits:

- [Certora Security Audit](./audit-reports/Certora-Relay-Escrow-Report.pdf)
