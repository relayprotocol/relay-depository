# TRON VM for Relay Protocol

TRON VM is the implementation of Relay Protocol for the TRON blockchain, directly reusing the Ethereum VM contract code with test adaptations specific to the TRON blockchain environment.

## Overview

TRON VM contains the RelayDepository smart contract, which is identical to the Ethereum VM implementation, with the following TRON-specific adaptations in testing and deployment:

- Uses TronWeb instead of Web3.js for contract interactions
- Adapted for TRON's event log parsing approach
- Supports TRC20 tokens (TRON's equivalent of ERC20)
- Uses TRON-specific implementation of EIP-712 signatures

## Features

The RelayDepository contract provides the following core functionalities:

- Native TRX token deposits
- TRC20 token deposits
- Secure withdrawal mechanism based on EIP-712 signatures
- Multi-call execution support

## Deployment Guide

### Environment Setup

1. Ensure TronBox is installed:
   ```shell
   npm install -g tronbox
   ```

2. Configure private keys and network information:
   - Copy `.env.example` to `.env` and fill in your private key
   - Check network configuration in `tronbox-config.js`

### Compiling Contracts

```shell
tronbox compile
```

### Deploying Contracts

#### Nile Testnet

```shell
tronbox migrate --network nile
```

#### Mainnet

```shell
tronbox migrate --network mainnet
```

## Differences from Ethereum VM

While the TRON VM contract code is identical to the Ethereum VM, there are several key differences in practical usage:

1. **Testing Environment**:
   - TRON VM uses TronBox and TronWeb for testing and deployment
   - Test scripts are adapted for TRON-specific features

2. **Event Handling**:
   - Event parsing in the TRON environment requires specific ordering
   - Should not rely on topics for event identification

3. **Address Format**:
   - TRON addresses typically start with 41 and need to be converted to 0x format in certain cases
   - Use `tronWeb.address.fromHex()` and `tronWeb.address.toHex()` for address format conversion

4. **Signature Verification**:
   - Uses TronWeb's `_signTypedData` method for EIP-712 signatures
   - Address format consistency requires special attention

## Testing Guide

When testing TRON VM contracts, note the following:

1. Use TronWeb instead of Web3.js:
   ```javascript
   const { TronWeb } = require('tronweb');
   ```

2. Use TronWeb's ABI functionality to parse event logs:
   ```javascript
   tronWeb.utils.abi.decodeParams([...], data);
   ```

3. Address format conversion:
   ```javascript
   tronWeb.address.fromHex(hexAddress);
   tronWeb.address.toHex(tronAddress);
   ```

4. Event log verification:
   - Verify event log existence
   - Confirm events are emitted by the correct contract
   - Verify event signatures
   - Parse and verify parameters

## License

MIT
