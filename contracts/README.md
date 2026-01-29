# Agent-Pay Smart Contracts

## PaymentReceiver

A simple contract that receives USDC payments on behalf of the gateway.

### Why Use a Contract Instead of an EOA?

Wallets like MetaMask show scary warnings when users approve spending to an EOA (regular wallet address):

> "This is a deceptive request. The spender is untrusted EOA."

This happens because:

1. **Scam pattern**: Attackers commonly trick users into approving their personal wallet, then drain funds
2. **No accountability**: EOAs have no code, so there's no way to verify what they'll do with the approval
3. **Wallet blacklists**: Security services flag suspicious EOAs, and wallets block approvals to them

### Why Contracts Are Trusted

**Verified contracts** solve this problem:

1. **Source code is public**: Anyone can read exactly what the contract does on Basescan/Etherscan
2. **Immutable behavior**: The code can't change (unlike an EOA owner who could do anything)
3. **Auditable**: Security researchers can verify there are no malicious functions
4. **On-chain verification**: Basescan shows a green checkmark ✓ for verified contracts

### Verification Process

After deploying, we "verify" the contract on Basescan:

```bash
# Using Foundry
forge verify-contract <CONTRACT_ADDRESS> PaymentReceiver \
  --chain base \
  --etherscan-api-key <BASESCAN_API_KEY> \
  --constructor-args $(cast abi-encode "constructor(address,address)" <USDC_ADDRESS> <OWNER_ADDRESS>)
```

This uploads the source code to Basescan, which:
1. Compiles it with the same settings
2. Checks the bytecode matches what's deployed
3. Displays the source code publicly with a ✓ verified badge

### What Wallets See

**Before (EOA):**
- ❌ Unknown address
- ❌ No code to inspect
- ❌ "Untrusted EOA" warning
- ❌ Blocked by security filters

**After (Verified Contract):**
- ✓ Verified source code on Basescan
- ✓ Clear, auditable functions
- ✓ No scary warnings
- ✓ Users can verify it only does `transferFrom`

## Deployment

### Prerequisites

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Install OpenZeppelin contracts
forge install OpenZeppelin/openzeppelin-contracts
```

### Deploy to Base Mainnet

```bash
# Set environment variables
export PRIVATE_KEY="your_deployer_private_key"
export BASESCAN_API_KEY="your_basescan_api_key"

# USDC on Base mainnet
USDC_ADDRESS="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

# Your gateway owner address (receives withdrawals)
OWNER_ADDRESS="0xYourOwnerAddress"

# Deploy
forge create src/PaymentReceiver.sol:PaymentReceiver \
  --rpc-url https://mainnet.base.org \
  --private-key $PRIVATE_KEY \
  --constructor-args $USDC_ADDRESS $OWNER_ADDRESS \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY
```

### Deploy to Base Sepolia (Testnet)

```bash
# USDC on Base Sepolia
USDC_ADDRESS="0x036CbD53842c5426634e7929541eC2318f3dCF7e"

forge create src/PaymentReceiver.sol:PaymentReceiver \
  --rpc-url https://sepolia.base.org \
  --private-key $PRIVATE_KEY \
  --constructor-args $USDC_ADDRESS $OWNER_ADDRESS \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY
```

## Contract Addresses

| Network      | Address | Verified |
|--------------|---------|----------|
| Base Mainnet | TBD     | ⏳       |
| Base Sepolia | TBD     | ⏳       |

## Security

- **Ownable**: Only the owner can call `pullPayment` and `withdraw`
- **ReentrancyGuard**: Prevents reentrancy attacks
- **SafeERC20**: Handles non-standard ERC20 implementations safely
- **Immutable USDC**: Token address can't be changed after deployment

## Gateway Integration

After deploying, update your gateway's `.env`:

```env
# Use the contract address instead of your EOA
PAYMENT_RECEIVER_ADDRESS=0xYourContractAddress

# The private key is still needed to call pullPayment
PAYMENT_RECEIVER_PRIVATE_KEY=your_owner_private_key
```

The gateway will call `pullPayment()` on the contract instead of `transferFrom()` directly.
