// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AgentPayEscrow.sol";

contract DeployEscrowScript is Script {
    // USDC addresses
    address constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // Gateway address (authorized to submit proofs and release funds)
    address constant GATEWAY = 0xf1AA30f0cF88a54CB8A60c977A4482c2CDda22d6;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        // Determine USDC address based on chain
        address usdc;
        if (block.chainid == 8453) {
            usdc = USDC_BASE;
        } else if (block.chainid == 84532) {
            usdc = USDC_BASE_SEPOLIA;
        } else {
            revert("Unsupported chain");
        }

        vm.startBroadcast(deployerPrivateKey);

        AgentPayEscrow escrow = new AgentPayEscrow(usdc, GATEWAY);

        console.log("AgentPayEscrow deployed to:", address(escrow));
        console.log("USDC address:", usdc);
        console.log("Gateway:", GATEWAY);

        vm.stopBroadcast();
    }
}
