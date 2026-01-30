// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================================
// REMIX-READY: Copy this entire file to Remix and deploy
// Constructor args for Base mainnet:
//   _usdc: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
//   _gateway: <your gateway wallet address>
// ============================================================================

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract AgentPayEscrow {
    address public owner;
    address public gateway;
    IERC20 public immutable usdc;

    uint256 public escrowTimeout = 1 hours;  // Timeout for gateway silence

    enum Status { None, Deposited, Released, Refunded }

    struct Escrow {
        address user;
        uint256 depositAmount;
        uint256 quotedAmount;      // Minimum required (from gateway quote)
        bytes32 specsHash;
        uint256 createdAt;
        Status status;
        string akashDseq;
        string akashProvider;
        uint256 actualCost;
    }

    struct DeploymentRecord {
        bytes32 escrowId;
        address user;
        bytes32 specsHash;
        uint256 quotedAmount;      // What was quoted
        uint256 amountPaid;        // What gateway actually charged
        uint256 userDeposit;       // What user deposited
        string akashDseq;
        string akashProvider;
        uint256 timestamp;
    }

    mapping(bytes32 => Escrow) public escrows;
    DeploymentRecord[] public deploymentRegistry;

    uint256 public totalDeposited;
    uint256 public totalReleased;
    uint256 public deploymentCount;

    event Deposited(bytes32 indexed escrowId, address indexed user, uint256 amount, bytes32 specsHash);
    event Released(bytes32 indexed escrowId, uint256 toGateway, uint256 refundToUser);
    event RefundedTimeout(bytes32 indexed escrowId, address indexed user, uint256 amount);
    event RefundedFailure(bytes32 indexed escrowId, address indexed user, uint256 amount, string reason);
    event DeploymentRecorded(uint256 indexed deploymentId, bytes32 indexed escrowId, string akashDseq);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyGateway() {
        require(msg.sender == gateway, "Not gateway");
        _;
    }

    constructor(address _usdc, address _gateway) {
        owner = msg.sender;
        gateway = _gateway;
        usdc = IERC20(_usdc);
    }

    // ======================== USER FUNCTIONS ========================

    /// @notice Deposit USDC into escrow.
    /// @param specsHash Hash of deployment specs (cpu, memory, storage, image, hours)
    /// @param quotedAmount The quoted price from gateway (minimum required)
    /// @param depositAmount Amount to deposit (must be >= quotedAmount, excess refunded later)
    function deposit(
        bytes32 specsHash,
        uint256 quotedAmount,
        uint256 depositAmount
    ) external returns (bytes32 escrowId) {
        require(quotedAmount > 0, "Invalid quote");
        require(depositAmount >= quotedAmount, "Deposit less than quoted amount");

        escrowId = keccak256(abi.encodePacked(msg.sender, specsHash, block.timestamp, block.number));
        require(escrows[escrowId].status == Status.None, "Escrow exists");

        require(usdc.transferFrom(msg.sender, address(this), depositAmount), "Transfer failed");

        escrows[escrowId] = Escrow({
            user: msg.sender,
            depositAmount: depositAmount,
            quotedAmount: quotedAmount,
            specsHash: specsHash,
            createdAt: block.timestamp,
            status: Status.Deposited,
            akashDseq: "",
            akashProvider: "",
            actualCost: 0
        });

        totalDeposited += depositAmount;
        emit Deposited(escrowId, msg.sender, depositAmount, specsHash);
    }

    /// @notice Claim refund if gateway never responded (after timeout)
    function claimRefund(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.status == Status.Deposited, "Not eligible");
        require(block.timestamp > e.createdAt + escrowTimeout, "Too early");

        e.status = Status.Refunded;
        require(usdc.transfer(e.user, e.depositAmount), "Refund failed");
        emit RefundedTimeout(escrowId, e.user, e.depositAmount);
    }

    // ======================== GATEWAY FUNCTIONS ========================

    /// @notice Submit proof of Akash deployment - triggers INSTANT release
    function submitProof(
        bytes32 escrowId,
        string calldata akashDseq,
        string calldata akashProvider,
        uint256 actualCost
    ) external onlyGateway {
        Escrow storage e = escrows[escrowId];
        require(e.status == Status.Deposited, "Invalid status");
        require(actualCost <= e.depositAmount, "Cost exceeds deposit");
        require(bytes(akashDseq).length > 0, "Invalid dseq");

        e.akashDseq = akashDseq;
        e.akashProvider = akashProvider;
        e.actualCost = actualCost;

        // Instant release - no delay
        _release(escrowId);
    }

    /// @notice Report deployment failure - triggers INSTANT refund to user
    function reportFailure(
        bytes32 escrowId,
        string calldata reason
    ) external onlyGateway {
        Escrow storage e = escrows[escrowId];
        require(e.status == Status.Deposited, "Invalid status");

        e.status = Status.Refunded;
        require(usdc.transfer(e.user, e.depositAmount), "Refund failed");
        emit RefundedFailure(escrowId, e.user, e.depositAmount, reason);
    }

    // ======================== INTERNAL ========================

    function _release(bytes32 escrowId) internal {
        Escrow storage e = escrows[escrowId];

        uint256 toGateway = e.actualCost;
        uint256 refund = e.depositAmount - e.actualCost;

        e.status = Status.Released;
        totalReleased += toGateway;

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
        deploymentCount++;

        emit DeploymentRecorded(deploymentId, escrowId, e.akashDseq);

        if (toGateway > 0) {
            require(usdc.transfer(gateway, toGateway), "Gateway transfer failed");
        }
        if (refund > 0) {
            require(usdc.transfer(e.user, refund), "Refund failed");
        }

        emit Released(escrowId, toGateway, refund);
    }

    // ======================== VIEW FUNCTIONS ========================

    function getEscrow(bytes32 escrowId) external view returns (
        address user,
        uint256 depositAmount,
        uint256 quotedAmount,
        bytes32 specsHash,
        Status status,
        string memory akashDseq,
        uint256 actualCost
    ) {
        Escrow storage e = escrows[escrowId];
        return (e.user, e.depositAmount, e.quotedAmount, e.specsHash, e.status, e.akashDseq, e.actualCost);
    }

    function getDeployment(uint256 id) external view returns (DeploymentRecord memory) {
        return deploymentRegistry[id];
    }

    function getDeploymentCount() external view returns (uint256) {
        return deploymentRegistry.length;
    }

    /// @notice Compute specs hash off-chain helper
    function computeSpecsHash(
        uint256 cpu,
        uint256 memoryMb,
        uint256 storageMb,
        string calldata image,
        uint256 durationHours
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(cpu, memoryMb, storageMb, image, durationHours));
    }

    // ======================== ADMIN ========================

    function setGateway(address _gateway) external onlyOwner {
        gateway = _gateway;
    }

    function setEscrowTimeout(uint256 _timeout) external onlyOwner {
        escrowTimeout = _timeout;
    }
}
