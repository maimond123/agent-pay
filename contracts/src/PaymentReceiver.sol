// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PaymentReceiver
 * @notice Receives USDC payments on behalf of the Agent-Pay gateway.
 * @dev This contract is used instead of an EOA to avoid wallet security warnings.
 *      Wallets trust verified smart contracts more than unknown EOA addresses.
 */
contract PaymentReceiver is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The USDC token contract
    IERC20 public immutable usdc;

    /// @notice Emitted when a payment is received
    event PaymentReceived(
        address indexed from,
        uint256 amount,
        string indexed deploymentId
    );

    /// @notice Emitted when funds are withdrawn
    event Withdrawn(
        address indexed to,
        uint256 amount
    );

    /**
     * @notice Creates a new PaymentReceiver
     * @param _usdc The USDC token address
     * @param _owner The owner who can withdraw funds
     */
    constructor(address _usdc, address _owner) Ownable(_owner) {
        require(_usdc != address(0), "Invalid USDC address");
        usdc = IERC20(_usdc);
    }

    /**
     * @notice Pulls a payment from a user who has approved this contract
     * @param from The address to pull payment from
     * @param amount The amount of USDC to pull (in smallest units, 6 decimals)
     * @param deploymentId Optional deployment ID for tracking
     * @return success Whether the transfer succeeded
     */
    function pullPayment(
        address from,
        uint256 amount,
        string calldata deploymentId
    ) external onlyOwner nonReentrant returns (bool success) {
        require(amount > 0, "Amount must be greater than 0");

        // Check allowance
        uint256 allowance = usdc.allowance(from, address(this));
        require(allowance >= amount, "Insufficient allowance");

        // Transfer from user to this contract
        usdc.safeTransferFrom(from, address(this), amount);

        emit PaymentReceived(from, amount, deploymentId);
        return true;
    }

    /**
     * @notice Withdraws accumulated USDC to a specified address
     * @param to The address to send funds to
     * @param amount The amount to withdraw (0 = all)
     */
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "Invalid recipient");

        uint256 balance = usdc.balanceOf(address(this));
        uint256 withdrawAmount = amount == 0 ? balance : amount;

        require(withdrawAmount <= balance, "Insufficient balance");
        require(withdrawAmount > 0, "Nothing to withdraw");

        usdc.safeTransfer(to, withdrawAmount);

        emit Withdrawn(to, withdrawAmount);
    }

    /**
     * @notice Returns the contract's USDC balance
     */
    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /**
     * @notice Returns the allowance a user has granted to this contract
     * @param owner The address that granted the allowance
     */
    function getAllowance(address owner) external view returns (uint256) {
        return usdc.allowance(owner, address(this));
    }
}
