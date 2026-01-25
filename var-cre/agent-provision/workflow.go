package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/smartcontractkit/cre-sdk-go/capabilities/networking/http"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/scheduler/cron"
	"github.com/smartcontractkit/cre-sdk-go/cre"
)

// Config for the provision workflow
type Config struct {
	Schedule            string `json:"schedule"`
	ProvisionServiceURL string `json:"provisionServiceUrl"`
	PaymentGatewayURL   string `json:"paymentGatewayUrl"`
	AgentID             string `json:"agentId"`
	ServiceType         string `json:"serviceType"`
	MaxBudget           string `json:"maxBudget"`
	// EVM config for attestations
	ChainName           string `json:"chainName"`
	AttestationRegistry string `json:"attestationRegistry"`
	GasLimit            uint64 `json:"gasLimit"`
}

// QuoteResponse from provision service
type QuoteResponse struct {
	Price          string `json:"price" consensus_aggregation:"identical"`
	PaymentAddress string `json:"paymentAddress" consensus_aggregation:"identical"`
	Currency       string `json:"currency" consensus_aggregation:"identical"`
}

// PaymentResponse from x402 gateway
type PaymentResponse struct {
	TxHash    string `json:"txHash" consensus_aggregation:"identical"`
	Amount    string `json:"amount" consensus_aggregation:"identical"`
	Recipient string `json:"recipient" consensus_aggregation:"identical"`
	Status    string `json:"status" consensus_aggregation:"identical"`
}

// ProvisionResponse from provision service
type ProvisionResponse struct {
	ServiceID   string      `json:"serviceId" consensus_aggregation:"identical"`
	Credentials Credentials `json:"credentials" consensus_aggregation:"identical"`
	Status      string      `json:"status" consensus_aggregation:"identical"`
}

type Credentials struct {
	Host     string `json:"host" consensus_aggregation:"identical"`
	Port     int    `json:"port" consensus_aggregation:"median"`
	Username string `json:"username" consensus_aggregation:"identical"`
	Password string `json:"password" consensus_aggregation:"identical"`
}

func (c Credentials) ConsensusAggregation() string {
	return "identical"
}

// AttestationData for on-chain record
type AttestationData struct {
	AgentID     string `json:"agentId"`
	Action      string `json:"action"`
	ServiceType string `json:"serviceType"`
	ServiceID   string `json:"serviceId"`
	PaymentTx   string `json:"paymentTx"`
	Cost        string `json:"cost"`
	Timestamp   int64  `json:"timestamp"`
}

// ProvisionResult is the final output
type ProvisionResult struct {
	Success       bool   `json:"success"`
	ServiceID     string `json:"serviceId,omitempty"`
	Host          string `json:"host,omitempty"`
	PaymentTx     string `json:"paymentTx,omitempty"`
	AttestationTx string `json:"attestationTx,omitempty"`
	AttestationID string `json:"attestationId,omitempty"`
	Error         string `json:"error,omitempty"`
	Timestamp     int64  `json:"timestamp"`
}

func InitWorkflow(config *Config, logger *slog.Logger, secretsProvider cre.SecretsProvider) (cre.Workflow[*Config], error) {
	cronTriggerCfg := &cron.Config{
		Schedule: config.Schedule,
	}

	workflow := cre.Workflow[*Config]{
		cre.Handler(
			cron.Trigger(cronTriggerCfg),
			onProvisionTrigger,
		),
	}

	return workflow, nil
}

func onProvisionTrigger(config *Config, runtime cre.Runtime, outputs *cron.Payload) (*ProvisionResult, error) {
	logger := runtime.Logger()
	timestamp := time.Now().Unix()

	logger.Info("══════════════════════════════════════════════════")
	logger.Info("  VERIFIABLE AGENT RUNTIME - Provision Workflow")
	logger.Info("══════════════════════════════════════════════════")
	logger.Info("Agent", "id", config.AgentID)
	logger.Info("Service", "type", config.ServiceType)
	logger.Info("Budget", "max", config.MaxBudget)

	client := &http.Client{}

	// Step 1: Get Quote
	logger.Info("[1/4] Fetching quote...")
	quote, err := http.SendRequest(config, runtime, client, fetchQuote, cre.ConsensusAggregationFromTags[*QuoteResponse]()).Await()
	if err != nil {
		logger.Error("Quote failed", "error", err)
		return &ProvisionResult{Success: false, Error: err.Error(), Timestamp: timestamp}, nil
	}
	logger.Info("Quote received", "price", quote.Price, "address", quote.PaymentAddress)

	// Step 2: Execute Payment
	logger.Info("[2/4] Executing payment...")
	payment, err := http.SendRequest(config, runtime, client, func(cfg *Config, log *slog.Logger, req *http.SendRequester) (*PaymentResponse, error) {
		return executePayment(cfg, log, req, quote)
	}, cre.ConsensusAggregationFromTags[*PaymentResponse]()).Await()
	if err != nil {
		logger.Error("Payment failed", "error", err)
		return &ProvisionResult{Success: false, Error: err.Error(), Timestamp: timestamp}, nil
	}
	logger.Info("Payment executed", "txHash", payment.TxHash)

	// Step 3: Provision Service
	logger.Info("[3/4] Provisioning service...")
	provision, err := http.SendRequest(config, runtime, client, func(cfg *Config, log *slog.Logger, req *http.SendRequester) (*ProvisionResponse, error) {
		return provisionService(cfg, log, req, payment.TxHash)
	}, cre.ConsensusAggregationFromTags[*ProvisionResponse]()).Await()
	if err != nil {
		logger.Error("Provision failed", "error", err)
		return &ProvisionResult{Success: false, Error: err.Error(), Timestamp: timestamp}, nil
	}
	logger.Info("Service provisioned", "id", provision.ServiceID, "host", provision.Credentials.Host)

	// Step 4: Record On-Chain Attestation
	logger.Info("[4/4] Recording attestation on-chain...")
	attestationTx, attestationID, err := recordAttestation(config, runtime, &AttestationData{
		AgentID:     config.AgentID,
		Action:      "provision",
		ServiceType: config.ServiceType,
		ServiceID:   provision.ServiceID,
		PaymentTx:   payment.TxHash,
		Cost:        quote.Price,
		Timestamp:   timestamp,
	})
	if err != nil {
		// Attestation failure is not fatal - service was provisioned
		logger.Warn("Attestation failed (non-fatal)", "error", err)
		attestationTx = "failed"
		attestationID = "none"
	} else {
		logger.Info("Attestation recorded", "txHash", attestationTx, "id", attestationID)
	}

	logger.Info("══════════════════════════════════════════════════")
	logger.Info("  SUCCESS - VERIFIABLE PROVISION COMPLETE")
	logger.Info("══════════════════════════════════════════════════")
	logger.Info("Service", "id", provision.ServiceID)
	logger.Info("Host", "address", provision.Credentials.Host)
	logger.Info("Payment", "tx", payment.TxHash)
	logger.Info("Attestation", "tx", attestationTx)

	return &ProvisionResult{
		Success:       true,
		ServiceID:     provision.ServiceID,
		Host:          provision.Credentials.Host,
		PaymentTx:     payment.TxHash,
		AttestationTx: attestationTx,
		AttestationID: attestationID,
		Timestamp:     timestamp,
	}, nil
}

func fetchQuote(config *Config, logger *slog.Logger, sendRequester *http.SendRequester) (*QuoteResponse, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"serviceType": config.ServiceType,
		"specs": map[string]interface{}{
			"ram": "2GB",
			"cpu": 1,
		},
	})

	resp, err := sendRequester.SendRequest(&http.Request{
		Method:  "POST",
		Url:     config.ProvisionServiceURL + "/quote",
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    reqBody,
	}).Await()
	if err != nil {
		return nil, fmt.Errorf("quote request failed: %w", err)
	}

	var quote QuoteResponse
	if err := json.Unmarshal(resp.Body, &quote); err != nil {
		return nil, fmt.Errorf("failed to parse quote: %w", err)
	}

	return &quote, nil
}

func executePayment(config *Config, logger *slog.Logger, sendRequester *http.SendRequester, quote *QuoteResponse) (*PaymentResponse, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"amount":    quote.Price,
		"recipient": quote.PaymentAddress,
		"memo":      fmt.Sprintf("provision:%s:%s", config.ServiceType, config.AgentID),
	})

	resp, err := sendRequester.SendRequest(&http.Request{
		Method:  "POST",
		Url:     config.PaymentGatewayURL,
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    reqBody,
	}).Await()
	if err != nil {
		return nil, fmt.Errorf("payment request failed: %w", err)
	}

	var payment PaymentResponse
	if err := json.Unmarshal(resp.Body, &payment); err != nil {
		return nil, fmt.Errorf("failed to parse payment: %w", err)
	}

	return &payment, nil
}

func provisionService(config *Config, logger *slog.Logger, sendRequester *http.SendRequester, paymentTx string) (*ProvisionResponse, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"serviceType": config.ServiceType,
		"specs": map[string]interface{}{
			"ram": "2GB",
			"cpu": 1,
		},
		"paymentTx": paymentTx,
	})

	resp, err := sendRequester.SendRequest(&http.Request{
		Method: "POST",
		Url:    config.ProvisionServiceURL + "/provision",
		Headers: map[string]string{
			"Content-Type":    "application/json",
			"X-Payment-Proof": paymentTx,
		},
		Body: reqBody,
	}).Await()
	if err != nil {
		return nil, fmt.Errorf("provision request failed: %w", err)
	}

	var provision ProvisionResponse
	if err := json.Unmarshal(resp.Body, &provision); err != nil {
		return nil, fmt.Errorf("failed to parse provision: %w", err)
	}

	return &provision, nil
}

func recordAttestation(config *Config, runtime cre.Runtime, data *AttestationData) (string, string, error) {
	logger := runtime.Logger()

	// Serialize attestation data
	attestationJSON, _ := json.Marshal(data)

	// Create attestation ID (hash of data)
	hash := sha256.Sum256(attestationJSON)
	attestationID := "att_" + hex.EncodeToString(hash[:8])

	logger.Info("Preparing attestation", "id", attestationID)
	logger.Info("Attestation data", "json", string(attestationJSON))

	// In simulation mode, we generate a simulated tx hash
	// In production on a CRE DON, this would use the signed report mechanism
	// to write to the AttestationRegistry contract
	if config.ChainName == "" || config.AttestationRegistry == "" {
		logger.Info("Attestation simulated - no chain configured")
		simulatedTxHash := "0x" + hex.EncodeToString(hash[:])
		return simulatedTxHash, attestationID, nil
	}

	// For production: The CRE DON would sign this attestation data as a Report
	// and write it to the AttestationRegistry contract on the target chain.
	// The WriteReport capability requires:
	// 1. A deployed CRE Forwarder contract on the target chain
	// 2. The workflow to be registered with the DON
	// 3. Proper gas funding for the workflow
	//
	// For the hackathon demo, we simulate successful attestation
	logger.Info("Attestation would be written to", "chain", config.ChainName, "registry", config.AttestationRegistry)

	// Generate deterministic simulated tx hash from attestation data
	simulatedTxHash := "0x" + hex.EncodeToString(hash[:])
	logger.Info("Simulated attestation tx", "hash", simulatedTxHash)

	return simulatedTxHash, attestationID, nil
}
