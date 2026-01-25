// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AttestationRegistry
 * @notice On-chain registry for verifiable agent action attestations
 * @dev Stores cryptographic proofs of agent actions executed through CRE
 *
 * Key features:
 * - Immutable record of agent actions
 * - Queryable by agent ID, action type, or time range
 * - Supports multiple proof types (CRE consensus, ZK, TEE)
 * - Gas-optimized for high-frequency attestations
 */
contract AttestationRegistry {
    // ============ Structs ============

    struct Attestation {
        bytes32 agentId;        // Unique agent identifier (hashed)
        bytes32 actionType;     // Type of action (payment, provision, etc.)
        bytes32 dataHash;       // Hash of action data
        bytes proof;            // Proof data (CRE consensus, ZK proof, or TEE attestation)
        ProofType proofType;    // Type of proof provided
        uint64 timestamp;       // Block timestamp when recorded
        uint64 blockNumber;     // Block number when recorded
        address recorder;       // Address that recorded (CRE DON address)
    }

    enum ProofType {
        CRE_CONSENSUS,  // Default: BFT consensus from Chainlink DON
        ZK_PROOF,       // Zero-knowledge proof for privacy-sensitive actions
        TEE_ATTESTATION // Trusted Execution Environment attestation
    }

    // ============ State ============

    // Attestation ID => Attestation
    mapping(bytes32 => Attestation) public attestations;

    // Agent ID => Attestation IDs (for querying agent history)
    mapping(bytes32 => bytes32[]) public agentAttestations;

    // Action type => Attestation IDs (for querying by action)
    mapping(bytes32 => bytes32[]) public actionAttestations;

    // Counter for generating unique attestation IDs
    uint256 public attestationCount;

    // Authorized CRE DON addresses that can record attestations
    mapping(address => bool) public authorizedRecorders;

    // Admin address (for adding recorders)
    address public admin;

    // ============ Events ============

    event AttestationRecorded(
        bytes32 indexed attestationId,
        bytes32 indexed agentId,
        bytes32 indexed actionType,
        bytes32 dataHash,
        ProofType proofType,
        uint64 timestamp
    );

    event RecorderAuthorized(address indexed recorder);
    event RecorderRevoked(address indexed recorder);

    // ============ Modifiers ============

    modifier onlyAuthorized() {
        require(authorizedRecorders[msg.sender] || msg.sender == admin, "Not authorized");
        _;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    // ============ Constructor ============

    constructor() {
        admin = msg.sender;
        authorizedRecorders[msg.sender] = true;
    }

    // ============ Core Functions ============

    /**
     * @notice Record a new attestation
     * @param agentId Unique identifier of the agent
     * @param actionType Type of action performed
     * @param dataHash Hash of the action data
     * @param proof Cryptographic proof of execution
     * @param proofType Type of proof provided
     * @return attestationId Unique ID of the recorded attestation
     */
    function recordAttestation(
        bytes32 agentId,
        bytes32 actionType,
        bytes32 dataHash,
        bytes calldata proof,
        ProofType proofType
    ) external onlyAuthorized returns (bytes32 attestationId) {
        attestationCount++;

        // Generate unique attestation ID
        attestationId = keccak256(
            abi.encodePacked(
                agentId,
                actionType,
                dataHash,
                block.timestamp,
                attestationCount
            )
        );

        // Store attestation
        attestations[attestationId] = Attestation({
            agentId: agentId,
            actionType: actionType,
            dataHash: dataHash,
            proof: proof,
            proofType: proofType,
            timestamp: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            recorder: msg.sender
        });

        // Index for queries
        agentAttestations[agentId].push(attestationId);
        actionAttestations[actionType].push(attestationId);

        emit AttestationRecorded(
            attestationId,
            agentId,
            actionType,
            dataHash,
            proofType,
            uint64(block.timestamp)
        );

        return attestationId;
    }

    /**
     * @notice Convenience function for CRE workflows
     * @dev Accepts string parameters and converts to bytes32
     */
    function recordAttestation(
        string calldata agentId,
        string calldata actionType,
        string calldata data,
        uint256 /* timestamp - ignored, use block.timestamp */
    ) external onlyAuthorized returns (bytes32) {
        return recordAttestation(
            keccak256(bytes(agentId)),
            keccak256(bytes(actionType)),
            keccak256(bytes(data)),
            "", // Empty proof for basic attestations
            ProofType.CRE_CONSENSUS
        );
    }

    // ============ Query Functions ============

    /**
     * @notice Get attestation by ID
     */
    function getAttestation(bytes32 attestationId)
        external
        view
        returns (Attestation memory)
    {
        return attestations[attestationId];
    }

    /**
     * @notice Get all attestation IDs for an agent
     */
    function getAgentAttestations(bytes32 agentId)
        external
        view
        returns (bytes32[] memory)
    {
        return agentAttestations[agentId];
    }

    /**
     * @notice Get attestation IDs for an agent with pagination
     */
    function getAgentAttestationsPaginated(
        bytes32 agentId,
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory) {
        bytes32[] storage all = agentAttestations[agentId];
        uint256 total = all.length;

        if (offset >= total) {
            return new bytes32[](0);
        }

        uint256 end = offset + limit;
        if (end > total) {
            end = total;
        }

        bytes32[] memory result = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = all[i];
        }

        return result;
    }

    /**
     * @notice Verify an attestation exists and matches expected data
     */
    function verifyAttestation(
        bytes32 attestationId,
        bytes32 expectedAgentId,
        bytes32 expectedActionType,
        bytes32 expectedDataHash
    ) external view returns (bool) {
        Attestation storage att = attestations[attestationId];

        return att.agentId == expectedAgentId &&
               att.actionType == expectedActionType &&
               att.dataHash == expectedDataHash &&
               att.timestamp > 0; // Exists
    }

    /**
     * @notice Get attestation count for an agent
     */
    function getAgentAttestationCount(bytes32 agentId)
        external
        view
        returns (uint256)
    {
        return agentAttestations[agentId].length;
    }

    // ============ Admin Functions ============

    function authorizeRecorder(address recorder) external onlyAdmin {
        authorizedRecorders[recorder] = true;
        emit RecorderAuthorized(recorder);
    }

    function revokeRecorder(address recorder) external onlyAdmin {
        authorizedRecorders[recorder] = false;
        emit RecorderRevoked(recorder);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Invalid admin");
        admin = newAdmin;
    }
}
