// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/PaymentReceiver.sol";

contract DeployScript is Script {
    // USDC addresses
    address constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address owner = vm.envAddress("OWNER_ADDRESS");

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

        PaymentReceiver receiver = new PaymentReceiver(usdc, owner);

        console.log("PaymentReceiver deployed to:", address(receiver));
        console.log("USDC address:", usdc);
        console.log("Owner:", owner);

        vm.stopBroadcast();
    }
}
