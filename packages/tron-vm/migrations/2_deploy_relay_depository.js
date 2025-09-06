const RelayDepository = artifacts.require("RelayDepository");
const fs = require('fs');
const path = require('path');

module.exports = async function(deployer, network, accounts) {
  console.log(`Deploying RelayDepository to ${network} network...`);
  // Default owner is the deployer account
  const owner = accounts;
  
  // Default allocator address - should be replaced with a secure address in production
  let allocator = accounts;

  // Check if environment variables are set for allocator address
  if (process.env.ALLOCATOR_ADDRESS && process.env.ALLOCATOR_ADDRESS.trim() !== '') {
    allocator = process.env.ALLOCATOR_ADDRESS;
    console.log(`Using allocator address from environment: ${allocator}`);
  } else {
    console.log(`Using default allocator address: ${allocator}`);
    console.log('WARNING: For production, set a secure allocator address via ALLOCATOR_ADDRESS environment variable');
  }

  console.log(`Deploying RelayDepository with owner: ${owner} and allocator: ${allocator}`);
  // Deploy the RelayDepository contract
  await deployer.deploy(RelayDepository, owner, allocator);
  const relayDepository = await RelayDepository.deployed();
  
  console.log(`RelayDepository deployed at: ${relayDepository.address}`);
  console.log(`Owner: ${owner}`);
  console.log(`Allocator: ${allocator}`);
  
  // Save deployment information to a file
  const deploymentInfo = {
    network,
    contractAddress: relayDepository.address,
    owner,
    allocator,
    deploymentTime: new Date().toISOString()
  };
  
  const deploymentsDir = path.join(__dirname, '../deployments');
  
  // Create deployments directory if it doesn't exist
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  
  // Write deployment info to a JSON file
  fs.writeFileSync(
    path.join(deploymentsDir, `${network}-deployment.json`),
    JSON.stringify(deploymentInfo, null, 2)
  );
  
  console.log(`Deployment information saved to ${network}-deployment.json`);
};
