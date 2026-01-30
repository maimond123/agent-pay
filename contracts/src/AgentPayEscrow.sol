// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgentPayEscrow
 * @notice Escrow contract for verifiable AI agent compute provisioning
 * @dev Combines escrow (trust-minimized payments) with registry (verifiable execution)
 *
 * Flow:
 * 1. User deposits USDC with a specs commitment (hash of cpu, memory, storage, image, hours)
 * 2. Gateway deploys on Akash and submits proof (dseq, provider, actual cost)
 * 3. On success: INSTANT release - gateway gets cost, user gets refund of excess
 * 4. On failure: INSTANT refund - user gets full deposit back
 * 5. On timeout (1hr): User can claim refund if gateway goes silent
 * 6. All deployments permanently recorded for auditability
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract AgentPayEscrow {
    // ============================================================================
    // STATE
    // ============================================================================

    address public owner;
    address public gateway;
    IERC20 public immutable usdc;

    uint256 public escrowTimeout = 1 hours;  // Timeout for gateway silence

    enum EscrowStatus {
        None,
        Deposited,      // User deposited, waiting for gateway
        Released,       // Funds released to gateway (success)
        Refunded        // Funds refunded to user (failure or timeout)
    }

    struct Escrow {
        address user;
        uint256 depositAmount;
        uint256 quotedAmount;
        bytes32 specsHash;
        uint256 createdAt;
        EscrowStatus status;
        string akashDseq;
        string akashProvider;
        uint256 actualCost;
    }

    struct DeploymentRecord {
        bytes32 escrowId;
        address user;
        bytes32 specsHash;
        uint256 quotedAmount;
        uint256 amountPaid;
        uint256 userDeposit;
        string akashDseq;
        string akashProvider;
        uint256 timestamp;
    }

    mapping(bytes32 => Escrow) public escrows;
    DeploymentRecord[] public deploymentRegistry;
    mapping(address => bytes32[]) public userEscrows;
    mapping(address => uint256[]) public userDeployments;

    uint256 public totalDeposited;
    uint256 public totalReleased;
    uint256 public totalRefunded;
    uint256 public deploymentCount;

    // ============================================================================
    // EVENTS
    // ============================================================================

    event Deposited(
        bytes32 indexed escrowId,
        address indexed user,
        uint256 amount,
        bytes32 specsHash
    );

    event Released(
        bytes32 indexed escrowId,
        address indexed user,
        uint256 toGateway,
        uint256 refundToUser
    );

    event RefundedTimeout(
        bytes32 indexed escrowId,
        address indexed user,
        uint256 amount
    );

    event RefundedFailure(
        bytes32 indexed escrowId,
        address indexed user,
        uint256 amount,
        string reason
    );

    event DeploymentRecorded(
        uint256 indexed deploymentId,
        bytes32 indexed escrowId,
        address indexed user,
        string akashDseq
    );

    // ============================================================================
    // MODIFIERS
    // ============================================================================

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyGateway() {
        require(msg.sender == gateway, "Not gateway");
        _;
    }

    // ============================================================================
    // CONSTRUCTOR
    // ============================================================================

    constructor(address _usdc, address _gateway) {
        owner = msg.sender;
        gateway = _gateway;
        usdc = IERC20(_usdc);
    }

    // ============================================================================
    // USER FUNCTIONS
    // ============================================================================

    /**
     * @notice Deposit USDC into escrow for a compute deployment
     * @param specsHash Hash of deployment specs (cpu, memory, storage, image, hours)
     * @param quotedAmount The quoted price from gateway (minimum required)
     * @param depositAmount Amount to deposit (must be >= quotedAmount)
     * @return escrowId Unique identifier for this escrow
     */
    function deposit(
        bytes32 specsHash,
        uint256 quotedAmount,
        uint256 depositAmount
    ) external returns (bytes32 escrowId) {
        require(quotedAmount > 0, "Invalid quote");
        require(depositAmount >= quotedAmount, "Deposit less than quoted amount");
        require(specsHash != bytes32(0), "Invalid specs hash");

        // Generate unique escrow ID
        escrowId = keccak256(abi.encodePacked(msg.sender, specsHash, block.timestamp, block.number));
        require(escrows[escrowId].status == EscrowStatus.None, "Escrow exists");

        // Transfer USDC to this contract
        require(usdc.transferFrom(msg.sender, address(this), depositAmount), "Transfer failed");

        // Create escrow
        escrows[escrowId] = Escrow({
            user: msg.sender,
            depositAmount: depositAmount,
            quotedAmount: quotedAmount,
            specsHash: specsHash,
            createdAt: block.timestamp,
            status: EscrowStatus.Deposited,
            akashDseq: "",
            akashProvider: "",
            actualCost: 0
        });

        userEscrows[msg.sender].push(escrowId);
        totalDeposited += depositAmount;

        emit Deposited(escrowId, msg.sender, depositAmount, specsHash);
        return escrowId;
    }

    /**
     * @notice Claim refund if gateway never responded (after timeout)
     * @param escrowId The escrow to refund
     */
    function claimRefund(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.Deposited, "Not eligible for refund");
        require(block.timestamp > e.createdAt + escrowTimeout, "Timeout not reached");

        e.status = EscrowStatus.Refunded;
        totalRefunded += e.depositAmount;

        require(usdc.transfer(e.user, e.depositAmount), "Refund failed");

        emit RefundedTimeout(escrowId, e.user, e.depositAmount);
    }

    // ============================================================================
    // GATEWAY FUNCTIONS
    // ============================================================================

    /**
     * @notice Submit proof of deployment - triggers INSTANT release
     * @param escrowId The escrow this deployment is for
     * @param akashDseq Akash deployment sequence number
     * @param akashProvider Akash provider address
     * @param actualCost Actual cost of the deployment
     */
    function submitProof(
        bytes32 escrowId,
        string calldata akashDseq,
        string calldata akashProvider,
        uint256 actualCost
    ) external onlyGateway {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.Deposited, "Invalid escrow status");
        require(actualCost <= e.depositAmount, "Actual cost exceeds deposit");
        require(bytes(akashDseq).length > 0, "Invalid dseq");

        e.akashDseq = akashDseq;
        e.akashProvider = akashProvider;
        e.actualCost = actualCost;

        // Instant release - no delay
        _release(escrowId);
    }

    /**
     * @notice Report deployment failure - triggers INSTANT refund
     * @param escrowId The escrow that failed
     * @param reason Why the deployment failed
     */
    function reportFailure(
        bytes32 escrowId,
        string calldata reason
    ) external onlyGateway {
        Escrow storage e = escrows[escrowId];
        require(e.status == EscrowStatus.Deposited, "Invalid escrow status");

        e.status = EscrowStatus.Refunded;
        totalRefunded += e.depositAmount;

        require(usdc.transfer(e.user, e.depositAmount), "Refund failed");

        emit RefundedFailure(escrowId, e.user, e.depositAmount, reason);
    }

    // ============================================================================
    // INTERNAL FUNCTIONS
    // ============================================================================

    function _release(bytes32 escrowId) internal {
        Escrow storage e = escrows[escrowId];

        uint256 toGateway = e.actualCost;
        uint256 refundToUser = e.depositAmount - e.actualCost;

        e.status = EscrowStatus.Released;
        totalReleased += toGateway;
        if (refundToUser > 0) {
            totalRefunded += refundToUser;
        }

        // Record in permanent registry
        uint256 deploymentId = deploymentRegistry.length;
        deploymentRegistry.push(DeploymentRecord({
            escrowId: escrowId,
            user: e.user,
            specsHash: e.specsHash,
            quotedAmount: e.quotedAmount,
            amountPaid: toGateway,
            userDeposit: e.depositAmount,
            akashDseq: e.akashDseq,
            akashProvider: e.akashProvider,
            timestamp: block.timestamp
        }));
        userDeployments[e.user].push(deploymentId);
        deploymentCount++;

        emit DeploymentRecorded(deploymentId, escrowId, e.user, e.akashDseq);

        // Transfer funds
        if (toGateway > 0) {
            require(usdc.transfer(gateway, toGateway), "Gateway transfer failed");
        }
        if (refundToUser > 0) {
            require(usdc.transfer(e.user, refundToUser), "Refund transfer failed");
        }

        emit Released(escrowId, e.user, toGateway, refundToUser);
    }

    // ============================================================================
    // VIEW FUNCTIONS
    // ============================================================================

    /**
     * @notice Get escrow details
     */
    function getEscrow(bytes32 escrowId) external view returns (
        address user,
        uint256 depositAmount,
        uint256 quotedAmount,
        bytes32 specsHash,
        uint256 createdAt,
        EscrowStatus status,
        string memory akashDseq,
        string memory akashProvider,
        uint256 actualCost
    ) {
        Escrow storage e = escrows[escrowId];
        return (
            e.user,
            e.depositAmount,
            e.quotedAmount,
            e.specsHash,
            e.createdAt,
            e.status,
            e.akashDseq,
            e.akashProvider,
            e.actualCost
        );
    }

    /**
     * @notice Get deployment record from registry
     */
    function getDeployment(uint256 deploymentId) external view returns (DeploymentRecord memory) {
        require(deploymentId < deploymentRegistry.length, "Invalid deployment ID");
        return deploymentRegistry[deploymentId];
    }

    /**
     * @notice Get all escrow IDs for a user
     */
    function getUserEscrows(address user) external view returns (bytes32[] memory) {
        return userEscrows[user];
    }

    /**
     * @notice Get all deployment IDs for a user
     */
    function getUserDeployments(address user) external view returns (uint256[] memory) {
        return userDeployments[user];
    }

    /**
     * @notice Get total deployment count
     */
    function getDeploymentCount() external view returns (uint256) {
        return deploymentRegistry.length;
    }

    /**
     * @notice Compute specs hash (helper for off-chain use)
     */
    function computeSpecsHash(
        uint256 cpu,
        uint256 memoryMb,
        uint256 storageMb,
        string calldata image,
        uint256 durationHours
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(cpu, memoryMb, storageMb, image, durationHours));
    }

    // ============================================================================
    // ADMIN FUNCTIONS
    // ============================================================================

    function setGateway(address _gateway) external onlyOwner {
        gateway = _gateway;
    }

    function setEscrowTimeout(uint256 _timeout) external onlyOwner {
        escrowTimeout = _timeout;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        owner = newOwner;
    }
}
