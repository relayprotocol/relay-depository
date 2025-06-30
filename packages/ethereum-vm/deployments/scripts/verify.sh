#!/bin/bash

# Get the verification flags from the deployment file
VERIFICATION_FLAGS=$(jq -c ".[] | select(.name == \"$CHAIN\") | .verificationFlags" "./deployments/$DEPLOYMENT_FILE")

# Split the verification flags into an array
expanded_verification_flags=(`echo $VERIFICATION_FLAGS | tr -d '"'`)

# Verify the contract using the above flags
forge verify-contract ${expanded_verification_flags[@]} $RELAY_DEPOSITORY ./src/RelayDepository.sol:RelayDepository --constructor-args $(cast abi-encode "constructor(address, address)" $DEPLOYER_ADDRESS $ALLOCATOR)