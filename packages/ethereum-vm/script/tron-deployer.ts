import { TronWeb } from "tronweb";

// Before running this script make sure to compile the contracts via Tronbox using `npx tronbox compile`

// Note! Since Tronbox is a fork of Truffle, some contract tweaks might be needed, especially around how
// the dependencies are being imported (Tronbox doesn't seem to support `remappings.txt`).

// Both the ABI and the bytecode are to be retrieved from the build artifacts (build/contracts/RelayDepository.json)
const abi = [];
const bytecode = "";

const tronWeb = new TronWeb({
  fullHost: process.env.FULL_NODE,
  privateKey: process.env.DEPLOYER_PK,
});

(async () => {
  const contract = await tronWeb.contract().new({
    abi,
    bytecode,
    parameters: [process.env.OWNER!, process.env.ALLOCATOR!],
    feeLimit: 100_000_000, // 100 TRX
    callValue: 0,
    userFeePercentage: 100,
    originEnergyLimit: 10_000_000,
  });

  console.log("Contract deployed at: ", contract.address);
})();
