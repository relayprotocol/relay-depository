## Ethereum VM

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Deploy

Before deploying make sure to have the following two environment variables configured:

- `DEPLOYER_PK`: the private key of the deployer
- `CHAIN`: the chain to deploy on (a corresponding entry for this chain should be available in `foundry.toml`)
- `ALLOCATOR`: the address of the allocator

```shell
$ forge script ./script/RelayEscrowDeploy.s.sol:RelayEscrowDeploy --slow --multi --broadcast --private-key $DEPLOYER_PK --verify
```
