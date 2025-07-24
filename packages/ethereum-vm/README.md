## Ethereum VM

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Deployment

Warning! For deterministic deployment make sure you're on commit `490858d742d1083bc4e3c2884798f6491dc72abb`.

The contracts deployment script is available in `./script/RelayDepositoryDeployer.s.sol`. It requires the following environment variables:

- `DEPLOYER_PK`: the private key of the deployer wallet
- `CHAIN`: the chain to deploy on (the available options can be found in `./foundry.toml`)
- `ALLOCATOR`: the address of the allocator
- `CREATE2_FACTORY`: the addres of the `CREATE2` factory to be used for deterministic deployments - the default factory should be deployed at `0x4e59b44847b379578588920ca78fbf26c0b4956c`, in case it's not available on a given chain we should deploy it there or otherwise use a different factory
- `ETHERSCAN_API_KEY`: the API key needed to verify the contracts on Etherscan-powered explorers

The deployment can be triggered via the following command:

```shell
forge script ./script/RelayDepositoryDeployer.s.sol:RelayDepositoryDeployer \
    --slow \
    --multi \
    --broadcast \
    --verify \
    --private-key $DEPLOYER_PK \
    --create2-deployer $CREATE2_FACTORY
```

Do not forget to add the corresponding deployment information to the `./deployments/addresses.json` file! Also, please ensure all deployed contracts are verified!

### Contract source code verification

The above script should do the deployment and verification altogether. However, in cases when the verification failed for some reason, it can be triggered individually via the following commands:

```shell
forge verify-contract --chain $CHAIN $RELAY_DEPOSITORY ./src/RelayDepository.sol:RelayDepository --constructor-args $(cast abi-encode "constructor(address)" $ALLOCATOR)
```

In case `forge` doesn't have any default explorer for a given chain, make sure to pass the following extra arguments to the `forge verify-contract` commands: `--verifier-url $VERIFIER_URL --etherscan-api-key $VERIFIER_API_KEY`.

### Contract logic verification

Since we need to deploy on a lot of chains which have different behaviour (eg. different supported evm version, with some opcodes not being available on some chains), it is important to ensure the logic of the contract works before going live with it on production. To help with that you can use the [`test-deposit-and-withdrawal`](./deployments/scripts/test-deposit-and-withdrawal.js) script which is going to execute a deposit to the depository and then request a withdrawal, ensuring both steps of the process work.
