#!/bin/bash

forge script ./script/RelayDepositoryDeployer.s.sol:RelayDepositoryDeployer \
    --slow \
    --broadcast \
    --private-key $DEPLOYER_PK \
    --create2-deployer $CREATE2_FACTORY