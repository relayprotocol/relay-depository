# Solana VM Relay Escrow

A Solana relay escrow smart contract built with the Anchor framework. This contract allows users to deposit SOL or SPL tokens and execute transfers with verified signatures.

## Project Overview

This contract provides the following key functionalities:
- Initialize the escrow contract and set owner and allocator
- Deposit SOL to the escrow account
- Deposit SPL tokens to the escrow account
- Execute transfers with allocator signature verification

## Installing Anchor

### Prerequisites
- [Rust](https://www.rust-lang.org/tools/install) (latest stable version)
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) (latest stable version)
- [Node.js](https://nodejs.org/en/download/) (v14 or higher)
- [Yarn](https://yarnpkg.com/getting-started/install)

### Installing the Anchor CLI

```bash
# Install Anchor CLI via npm
npm install -g @project-serum/anchor-cli

# Or install via cargo
cargo install --git https://github.com/project-serum/anchor anchor-cli --locked

# Verify the installation
anchor --version
```

## Project Setup

1. Clone the project repository

```bash
git clone <repository-url>
cd escrow-contracts/packages/solana-vm
```

2. Install dependencies

```bash
yarn install
```

3. Build the project

```bash
anchor build
```

4. Update the program ID

After building, get the program ID and update it in the `Anchor.toml` and `lib.rs` files:

```bash
anchor keys list
# Example output:
# relay_escrow: 2eAeUDN5EpxUB8ebCPu2HNnC9r1eJ3m2JSXGUWdxCMJg
```

Make sure to update the program ID in:
- `Anchor.toml` under `[programs.localnet]`
- `programs/relay-escrow/src/lib.rs` in the `declare_id!()` function call

## Testing the Contract

### Local Testing

1. Start a local validator node (optional, if you don't want to use the `--skip-local-validator` flag during testing)

```bash
solana-test-validator
```

2. Run the tests

```bash
# If you've manually started the validator
anchor test --skip-local-validator

# Or let Anchor start the validator automatically
anchor test
```

# Common Testing Issues and Solutions

## Case 1: Test Validator Not Started

### Error Message
```
Unable to get latest blockhash. Test validator does not look started. 
Check .anchor/test-ledger/test-ledger-log.txt for errors. 
Consider increasing [test.startup_wait] in Anchor.toml.
```

### Solution
1. Start Solana local network manually:
```bash
solana-test-validator
```

2. Run anchor test with the skip validator flag:
```bash
anchor test --skip-local-validator
```

## Case 2: Program ID Mismatch

### Error Message
```
Error: AnchorError occurred. Error Code: DeclaredProgramIdMismatch. 
Error Number: 4100. Error Message: The declared program id does not match the actual program id.
```

### Solution
1. Get the correct program ID:
```bash
anchor keys list
# Output example:
# relay_escrow: 2eAeUDN5EpxUB8ebCPu2HNnC9r1eJ3m2JSXGUWdxCMJg
```

2. Update the program ID in your source code (`src/lib.rs`):
```rust
declare_id!("2eAeUDN5EpxUB8ebCPu2HNnC9r1eJ3m2JSXGUWdxCMJg");
```

## Project Structure

```
solana-vm/
├── Anchor.toml          # Anchor configuration file
├── Cargo.toml           # Rust dependencies configuration
├── programs/            # Contract code directory
│   └── relay-escrow/    # Relay escrow contract
│       ├── Cargo.toml   
│       └── src/
│           └── lib.rs   # Main contract code
├── tests/               # Test code directory
├── app/                 # Frontend application (if applicable)
└── migrations/          # Deployment scripts (if applicable)
```

## Contribution Guidelines

1. Fork the project
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details