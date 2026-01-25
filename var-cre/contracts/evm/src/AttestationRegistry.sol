// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title AttestationRegistry
 * @notice Records verifiable attestations of agent actions
 * @dev Used by Chainlink CRE workflows to create immutable proofs
 */
contract AttestationRegistry {
    struct Attestation {
        bytes32 agentId;
        bytes32 actionType;
        bytes data;
        uint256 timestamp;
        address creWorkflow;
    }

    // attestationId => Attestation
    mapping(bytes32 => Attestation) public attestations;

    // All attestation IDs for enumeration
    bytes32[] public attestationIds;

    // Events
    event AttestationRecorded(
        bytes32 indexed attestationId,
        bytes32 indexed agentId,
        bytes32 indexed actionType,
        uint256 timestamp
    );

    /**
     * @notice Record a new attestation
     * @param agentId Identifier of the agent
     * @param actionType Type of action (e.g., "provision", "payment")
     * @param data Arbitrary data about the action (JSON encoded)
     * @return attestationId Unique identifier for this attestation
     */
    function recordAttestation(
        bytes32 agentId,
        bytes32 actionType,
        bytes calldata data
    ) external returns (bytes32 attestationId) {
        attestationId = keccak256(abi.encodePacked(
            agentId,
            actionType,
            data,
            block.timestamp,
            msg.sender
        ));

        attestations[attestationId] = Attestation({
            agentId: agentId,
            actionType: actionType,
            data: data,
            timestamp: block.timestamp,
            creWorkflow: msg.sender
        });

        attestationIds.push(attestationId);

        emit AttestationRecorded(
            attestationId,
            agentId,
            actionType,
            block.timestamp
        );

        return attestationId;
    }

    /**
     * @notice Get attestation by ID
     */
    function getAttestation(bytes32 attestationId)
        external
        view
        returns (
            bytes32 agentId,
            bytes32 actionType,
            bytes memory data,
            uint256 timestamp,
            address creWorkflow
        )
    {
        Attestation storage att = attestations[attestationId];
        return (
            att.agentId,
            att.actionType,
            att.data,
            att.timestamp,
            att.creWorkflow
        );
    }

    /**
     * @notice Get total number of attestations
     */
    function getAttestationCount() external view returns (uint256) {
        return attestationIds.length;
    }

    /**
     * @notice Verify an attestation exists
     */
    function verifyAttestation(bytes32 attestationId) external view returns (bool) {
        return attestations[attestationId].timestamp > 0;
    }
}
