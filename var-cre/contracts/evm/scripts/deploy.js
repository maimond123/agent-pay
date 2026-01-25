const hre = require("hardhat");

async function main() {
  console.log("Deploying AttestationRegistry to", hre.network.name);

  const AttestationRegistry = await hre.ethers.getContractFactory("AttestationRegistry");
  const registry = await AttestationRegistry.deploy();

  await registry.waitForDeployment();
  const address = await registry.getAddress();

  console.log("\n========================================");
  console.log("AttestationRegistry deployed to:", address);
  console.log("Network:", hre.network.name);
  console.log("========================================\n");

  // Output for config files
  console.log("Add to your config files:");
  console.log(`ATTESTATION_REGISTRY_ADDRESS=${address}`);

  // Verify instructions
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("\nTo verify on Basescan:");
    console.log(`npx hardhat verify --network ${hre.network.name} ${address}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
