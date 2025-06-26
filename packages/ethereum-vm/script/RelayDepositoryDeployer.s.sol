// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";

import {RelayDepository} from "../src/RelayDepository.sol";

contract RelayDepositoryDeployer is Script {
    // Thrown when the predicted address doesn't match the deployed address
    error IncorrectContractAddress(address predicted, address actual);

    // Modify for vanity address generation
    bytes32 public SALT = bytes32(uint256(1));

    function setUp() public {}

    function run() public {
        vm.createSelectFork(vm.envString("CHAIN"));

        vm.startBroadcast();

        address allocator = vm.envAddress("ALLOCATOR");

        RelayDepository relayDepository = RelayDepository(
            payable(deployRelayDepository(allocator))
        );

        assert(relayDepository.allocator() == allocator);

        vm.stopBroadcast();
    }

    function deployRelayDepository(address allocator) public returns (address) {
        console2.log("Deploying RelayDepository");

        address create2Factory = vm.envAddress("CREATE2_FACTORY");

        // Compute predicted address
        address predictedAddress = address(
            uint160(
                uint(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            create2Factory,
                            SALT,
                            keccak256(
                                abi.encodePacked(
                                    type(RelayDepository).creationCode,
                                    abi.encode(msg.sender, allocator)
                                )
                            )
                        )
                    )
                )
            )
        );

        console2.log("Predicted address for RelayDepository", predictedAddress);

        // Verify if the contract has already been deployed
        if (_hasBeenDeployed(predictedAddress)) {
            console2.log("RelayDepository was already deployed");
            return predictedAddress;
        }

        // Deploy
        RelayDepository relayDepository = new RelayDepository{salt: SALT}(
            msg.sender,
            allocator
        );

        // Ensure the predicted and actual addresses match
        if (predictedAddress != address(relayDepository)) {
            revert IncorrectContractAddress(
                predictedAddress,
                address(relayDepository)
            );
        }

        console2.log("RelayDepository deployed");

        return address(relayDepository);
    }

    function _hasBeenDeployed(
        address addressToCheck
    ) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(addressToCheck)
        }
        return (size > 0);
    }
}
