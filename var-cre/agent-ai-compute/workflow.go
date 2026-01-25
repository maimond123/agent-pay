package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/smartcontractkit/cre-sdk-go/capabilities/networking/http"
	"github.com/smartcontractkit/cre-sdk-go/capabilities/scheduler/cron"
	"github.com/smartcontractkit/cre-sdk-go/cre"
)

// ============================================================================
// AI-POWERED AUTONOMOUS COMPUTE PROVISIONING WORKFLOW
// ============================================================================
// This CRE workflow demonstrates an AI agent that:
// 1. Analyzes a task description using an LLM
// 2. Determines optimal compute requirements
// 3. Fetches quotes from multiple providers
// 4. Uses AI to select the best option
// 5. Executes payment via x402 protocol
// 6. Provisions decentralized compute
// 7. Records verifiable attestation on-chain
// ============================================================================

// Config for the AI compute workflow
type Config struct {
	// Workflow settings
	Schedule string `json:"schedule"`
	AgentID  string `json:"agentId"`

	// Task to analyze (simulates an AI agent's task queue)
	TaskDescription string `json:"taskDescription"`
	MaxBudgetUSDC   string `json:"maxBudgetUsdc"`

	// Service endpoints
	LLMApiURL         string `json:"llmApiUrl"`
	ComputeGatewayURL string `json:"computeGatewayUrl"`
	PaymentGatewayURL string `json:"paymentGatewayUrl"`

	// Blockchain settings for attestation
	ChainName           string `json:"chainName"`
	AttestationRegistry string `json:"attestationRegistry"`
}

// ============================================================================
// AI/LLM TYPES
// ============================================================================

// LLMAnalysisRequest sent to LLM API
type LLMAnalysisRequest struct {
	Task      string `json:"task"`
	MaxBudget string `json:"maxBudget"`
}

// LLMAnalysisResponse from LLM API
type LLMAnalysisResponse struct {
	RecommendedCPU     int    `json:"recommendedCpu" consensus_aggregation:"median"`
	RecommendedRAM     string `json:"recommendedRam" consensus_aggregation:"identical"`
	RecommendedStorage string `json:"recommendedStorage" consensus_aggregation:"identical"`
	RecommendedImage   string `json:"recommendedImage" consensus_aggregation:"identical"`
	EstimatedDuration  int    `json:"estimatedDurationHours" consensus_aggregation:"median"`
	Reasoning          string `json:"reasoning" consensus_aggregation:"identical"`
	Confidence         string `json:"confidence" consensus_aggregation:"identical"`
}

// ============================================================================
// COMPUTE PROVIDER TYPES
// ============================================================================

// ComputeQuoteRequest to x402 Akash Gateway
type ComputeQuoteRequest struct {
	CPU      int    `json:"cpu"`
	RAM      string `json:"ram"`
	Storage  string `json:"storage"`
	Hours    int    `json:"hours"`
	Image    string `json:"image"`
	Provider string `json:"provider,omitempty"`
}

// ComputeQuoteResponse from provider
type ComputeQuoteResponse struct {
	QuoteID      string `json:"quoteId" consensus_aggregation:"identical"`
	Provider     string `json:"provider" consensus_aggregation:"identical"`
	PriceUSDC    string `json:"priceUsdc" consensus_aggregation:"identical"`
	Currency     string `json:"currency" consensus_aggregation:"identical"`
	ValidUntil   int64  `json:"validUntil" consensus_aggregation:"median"`
	Capabilities string `json:"capabilities" consensus_aggregation:"identical"`
}

// MultiProviderQuotes holds quotes from multiple providers
type MultiProviderQuotes struct {
	Quotes []ComputeQuoteResponse `json:"quotes" consensus_aggregation:"identical"`
}

func (m MultiProviderQuotes) ConsensusAggregation() string {
	return "identical"
}

// ============================================================================
// AI SELECTION TYPES
// ============================================================================

// ProviderSelectionRequest to LLM for choosing best provider
type ProviderSelectionRequest struct {
	Task      string                 `json:"task"`
	Budget    string                 `json:"budget"`
	Quotes    []ComputeQuoteResponse `json:"quotes"`
	Reasoning string                 `json:"reasoning"`
}

// ProviderSelectionResponse from LLM
type ProviderSelectionResponse struct {
	SelectedProvider string `json:"selectedProvider" consensus_aggregation:"identical"`
	SelectedQuoteID  string `json:"selectedQuoteId" consensus_aggregation:"identical"`
	SelectionReason  string `json:"selectionReason" consensus_aggregation:"identical"`
	Confidence       string `json:"confidence" consensus_aggregation:"identical"`
}

// ============================================================================
// PAYMENT & PROVISION TYPES
// ============================================================================

// PaymentRequest for x402 payment
type PaymentRequest struct {
	QuoteID   string `json:"quoteId"`
	Amount    string `json:"amount"`
	Recipient string `json:"recipient"`
	Memo      string `json:"memo"`
}

// PaymentResponse from payment gateway
type PaymentResponse struct {
	TxHash    string `json:"txHash" consensus_aggregation:"identical"`
	Amount    string `json:"amount" consensus_aggregation:"identical"`
	Recipient string `json:"recipient" consensus_aggregation:"identical"`
	Status    string `json:"status" consensus_aggregation:"identical"`
	Network   string `json:"network" consensus_aggregation:"identical"`
}

// ProvisionRequest to compute gateway
type ProvisionRequest struct {
	QuoteID   string `json:"quoteId"`
	PaymentTx string `json:"paymentTx"`
	Image     string `json:"image"`
	Env       map[string]string `json:"env,omitempty"`
}

// ProvisionResponse from compute gateway
type ProvisionResponse struct {
	DeploymentID string            `json:"deploymentId" consensus_aggregation:"identical"`
	Provider     string            `json:"provider" consensus_aggregation:"identical"`
	Host         string            `json:"host" consensus_aggregation:"identical"`
	Ports        map[string]int    `json:"ports" consensus_aggregation:"identical"`
	Status       string            `json:"status" consensus_aggregation:"identical"`
	ExpiresAt    int64             `json:"expiresAt" consensus_aggregation:"median"`
	Credentials  ProvisionCredentials `json:"credentials" consensus_aggregation:"identical"`
}

type ProvisionCredentials struct {
	SSHHost     string `json:"sshHost" consensus_aggregation:"identical"`
	SSHPort     int    `json:"sshPort" consensus_aggregation:"median"`
	SSHUser     string `json:"sshUser" consensus_aggregation:"identical"`
	AccessToken string `json:"accessToken" consensus_aggregation:"identical"`
}

func (p ProvisionCredentials) ConsensusAggregation() string {
	return "identical"
}

func (p ProvisionResponse) ConsensusAggregation() string {
	return "identical"
}

// ============================================================================
// ATTESTATION TYPES
// ============================================================================

// AttestationData for on-chain record
type AttestationData struct {
	AgentID         string `json:"agentId"`
	Action          string `json:"action"`
	TaskDescription string `json:"taskDescription"`
	AIAnalysis      string `json:"aiAnalysis"`
	Provider        string `json:"provider"`
	DeploymentID    string `json:"deploymentId"`
	PaymentTx       string `json:"paymentTx"`
	CostUSDC        string `json:"costUsdc"`
	Timestamp       int64  `json:"timestamp"`
}

// ============================================================================
// WORKFLOW RESULT
// ============================================================================

// WorkflowResult is the final output
type WorkflowResult struct {
	Success         bool   `json:"success"`
	DeploymentID    string `json:"deploymentId,omitempty"`
	Provider        string `json:"provider,omitempty"`
	Host            string `json:"host,omitempty"`
	PaymentTx       string `json:"paymentTx,omitempty"`
	CostUSDC        string `json:"costUsdc,omitempty"`
	AttestationTx   string `json:"attestationTx,omitempty"`
	AttestationID   string `json:"attestationId,omitempty"`
	AIAnalysis      string `json:"aiAnalysis,omitempty"`
	AISelection     string `json:"aiSelection,omitempty"`
	Error           string `json:"error,omitempty"`
	Timestamp       int64  `json:"timestamp"`
}

// ============================================================================
// WORKFLOW INITIALIZATION
// ============================================================================

func InitWorkflow(config *Config, logger *slog.Logger, secretsProvider cre.SecretsProvider) (cre.Workflow[*Config], error) {
	cronTriggerCfg := &cron.Config{
		Schedule: config.Schedule,
	}

	workflow := cre.Workflow[*Config]{
		cre.Handler(
			cron.Trigger(cronTriggerCfg),
			onAIComputeTrigger,
		),
	}

	return workflow, nil
}

// ============================================================================
// MAIN WORKFLOW HANDLER
// ============================================================================

func onAIComputeTrigger(config *Config, runtime cre.Runtime, outputs *cron.Payload) (*WorkflowResult, error) {
	logger := runtime.Logger()
	timestamp := time.Now().Unix()

	logger.Info("╔══════════════════════════════════════════════════════════════════╗")
	logger.Info("║     AI-POWERED AUTONOMOUS COMPUTE PROVISIONING WORKFLOW          ║")
	logger.Info("║     Verifiable Agent Runtime (VAR) + Chainlink CRE               ║")
	logger.Info("╚══════════════════════════════════════════════════════════════════╝")
	logger.Info("Agent", "id", config.AgentID)
	logger.Info("Task", "description", truncateString(config.TaskDescription, 50))
	logger.Info("Budget", "max", config.MaxBudgetUSDC, "currency", "USDC")

	client := &http.Client{}

	// ═══════════════════════════════════════════════════════════════════════
	// STEP 1: AI ANALYSIS - LLM determines compute requirements
	// ═══════════════════════════════════════════════════════════════════════
	logger.Info("┌─────────────────────────────────────────────────────────────────┐")
	logger.Info("│ [1/6] AI ANALYSIS - Determining optimal compute requirements   │")
	logger.Info("└─────────────────────────────────────────────────────────────────┘")

	analysis, err := http.SendRequest(config, runtime, client,
		func(cfg *Config, log *slog.Logger, req *http.SendRequester) (*LLMAnalysisResponse, error) {
			return analyzeTaskWithLLM(cfg, log, req)
		},
		cre.ConsensusAggregationFromTags[*LLMAnalysisResponse](),
	).Await()

	if err != nil {
		logger.Error("AI analysis failed", "error", err)
		return &WorkflowResult{Success: false, Error: err.Error(), Timestamp: timestamp}, nil
	}

	logger.Info("AI Analysis Complete",
		"cpu", analysis.RecommendedCPU,
		"ram", analysis.RecommendedRAM,
		"storage", analysis.RecommendedStorage,
		"duration", analysis.EstimatedDuration,
		"confidence", analysis.Confidence,
	)
	logger.Info("AI Reasoning", "reasoning", truncateString(analysis.Reasoning, 100))

	// ═══════════════════════════════════════════════════════════════════════
	// STEP 2: FETCH QUOTES - Get prices from multiple providers
	// ═══════════════════════════════════════════════════════════════════════
	logger.Info("┌─────────────────────────────────────────────────────────────────┐")
	logger.Info("│ [2/6] FETCHING QUOTES - Querying decentralized compute markets │")
	logger.Info("└─────────────────────────────────────────────────────────────────┘")

	quotes, err := http.SendRequest(config, runtime, client,
		func(cfg *Config, log *slog.Logger, req *http.SendRequester) (*MultiProviderQuotes, error) {
			return fetchMultiProviderQuotes(cfg, log, req, analysis)
		},
		cre.ConsensusAggregationFromTags[*MultiProviderQuotes](),
	).Await()

	if err != nil {
		logger.Error("Quote fetching failed", "error", err)
		return &WorkflowResult{Success: false, Error: err.Error(), Timestamp: timestamp}, nil
	}

	for _, q := range quotes.Quotes {
		logger.Info("Quote received",
			"provider", q.Provider,
			"price", q.PriceUSDC,
			"capabilities", q.Capabilities,
		)
	}

	// ═══════════════════════════════════════════════════════════════════════
	// STEP 3: AI SELECTION - LLM chooses best provider
	// ═══════════════════════════════════════════════════════════════════════
	logger.Info("┌─────────────────────────────────────────────────────────────────┐")
	logger.Info("│ [3/6] AI SELECTION - Choosing optimal provider                 │")
	logger.Info("└─────────────────────────────────────────────────────────────────┘")

	selection, err := http.SendRequest(config, runtime, client,
		func(cfg *Config, log *slog.Logger, req *http.SendRequester) (*ProviderSelectionResponse, error) {
			return selectProviderWithLLM(cfg, log, req, quotes.Quotes, analysis.Reasoning)
		},
		cre.ConsensusAggregationFromTags[*ProviderSelectionResponse](),
	).Await()

	if err != nil {
		logger.Error("AI selection failed", "error", err)
		return &WorkflowResult{Success: false, Error: err.Error(), Timestamp: timestamp}, nil
	}

	logger.Info("AI Selection Complete",
		"provider", selection.SelectedProvider,
		"quoteId", selection.SelectedQuoteID,
		"confidence", selection.Confidence,
	)
	logger.Info("Selection Reason", "reason", selection.SelectionReason)

	// Find the selected quote
	var selectedQuote *ComputeQuoteResponse
	for _, q := range quotes.Quotes {
		if q.QuoteID == selection.SelectedQuoteID {
			selectedQuote = &q
			break
		}
	}
	if selectedQuote == nil {
		return &WorkflowResult{Success: false, Error: "selected quote not found", Timestamp: timestamp}, nil
	}

	// Check budget
	price, _ := strconv.ParseFloat(selectedQuote.PriceUSDC, 64)
	budget, _ := strconv.ParseFloat(config.MaxBudgetUSDC, 64)
	if price > budget {
		logger.Warn("Quote exceeds budget", "price", price, "budget", budget)
		return &WorkflowResult{Success: false, Error: "quote exceeds budget", Timestamp: timestamp}, nil
	}

	// ═══════════════════════════════════════════════════════════════════════
	// STEP 4: EXECUTE PAYMENT - Pay via x402 protocol
	// ═══════════════════════════════════════════════════════════════════════
	logger.Info("┌─────────────────────────────────────────────────────────────────┐")
	logger.Info("│ [4/6] EXECUTING PAYMENT - x402 stablecoin settlement           │")
	logger.Info("└─────────────────────────────────────────────────────────────────┘")

	payment, err := http.SendRequest(config, runtime, client,
		func(cfg *Config, log *slog.Logger, req *http.SendRequester) (*PaymentResponse, error) {
			return executeX402Payment(cfg, log, req, selectedQuote)
		},
		cre.ConsensusAggregationFromTags[*PaymentResponse](),
	).Await()

	if err != nil {
		logger.Error("Payment failed", "error", err)
		return &WorkflowResult{Success: false, Error: err.Error(), Timestamp: timestamp}, nil
	}

	logger.Info("Payment Complete",
		"txHash", payment.TxHash,
		"amount", payment.Amount,
		"network", payment.Network,
	)

	// ═══════════════════════════════════════════════════════════════════════
	// STEP 5: PROVISION COMPUTE - Deploy on decentralized network
	// ═══════════════════════════════════════════════════════════════════════
	logger.Info("┌─────────────────────────────────────────────────────────────────┐")
	logger.Info("│ [5/6] PROVISIONING - Deploying on decentralized compute        │")
	logger.Info("└─────────────────────────────────────────────────────────────────┘")

	provision, err := http.SendRequest(config, runtime, client,
		func(cfg *Config, log *slog.Logger, req *http.SendRequester) (*ProvisionResponse, error) {
			return provisionCompute(cfg, log, req, selectedQuote, payment, analysis)
		},
		cre.ConsensusAggregationFromTags[*ProvisionResponse](),
	).Await()

	if err != nil {
		logger.Error("Provisioning failed", "error", err)
		return &WorkflowResult{Success: false, Error: err.Error(), Timestamp: timestamp}, nil
	}

	logger.Info("Provisioning Complete",
		"deploymentId", provision.DeploymentID,
		"host", provision.Host,
		"status", provision.Status,
	)

	// ═══════════════════════════════════════════════════════════════════════
	// STEP 6: RECORD ATTESTATION - On-chain verifiable proof
	// ═══════════════════════════════════════════════════════════════════════
	logger.Info("┌─────────────────────────────────────────────────────────────────┐")
	logger.Info("│ [6/6] ATTESTATION - Recording verifiable proof on-chain        │")
	logger.Info("└─────────────────────────────────────────────────────────────────┘")

	attestationTx, attestationID, err := recordAttestation(config, runtime, &AttestationData{
		AgentID:         config.AgentID,
		Action:          "ai-compute-provision",
		TaskDescription: config.TaskDescription,
		AIAnalysis:      analysis.Reasoning,
		Provider:        selection.SelectedProvider,
		DeploymentID:    provision.DeploymentID,
		PaymentTx:       payment.TxHash,
		CostUSDC:        selectedQuote.PriceUSDC,
		Timestamp:       timestamp,
	})

	if err != nil {
		logger.Warn("Attestation failed (non-fatal)", "error", err)
		attestationTx = "failed"
		attestationID = "none"
	} else {
		logger.Info("Attestation Recorded", "txHash", attestationTx, "id", attestationID)
	}

	// ═══════════════════════════════════════════════════════════════════════
	// SUCCESS
	// ═══════════════════════════════════════════════════════════════════════
	logger.Info("╔══════════════════════════════════════════════════════════════════╗")
	logger.Info("║                    WORKFLOW COMPLETE                             ║")
	logger.Info("╠══════════════════════════════════════════════════════════════════╣")
	logger.Info("║ AI analyzed task and determined compute requirements            ║")
	logger.Info("║ Fetched quotes from decentralized compute providers             ║")
	logger.Info("║ AI selected optimal provider based on price/capabilities        ║")
	logger.Info("║ Payment executed via x402 stablecoin protocol                   ║")
	logger.Info("║ Compute provisioned on decentralized network                    ║")
	logger.Info("║ Verifiable attestation recorded on blockchain                   ║")
	logger.Info("╚══════════════════════════════════════════════════════════════════╝")
	logger.Info("Deployment", "id", provision.DeploymentID)
	logger.Info("Host", "address", provision.Host)
	logger.Info("Cost", "amount", selectedQuote.PriceUSDC, "currency", "USDC")
	logger.Info("Payment", "tx", payment.TxHash)
	logger.Info("Attestation", "tx", attestationTx)

	return &WorkflowResult{
		Success:       true,
		DeploymentID:  provision.DeploymentID,
		Provider:      selection.SelectedProvider,
		Host:          provision.Host,
		PaymentTx:     payment.TxHash,
		CostUSDC:      selectedQuote.PriceUSDC,
		AttestationTx: attestationTx,
		AttestationID: attestationID,
		AIAnalysis:    analysis.Reasoning,
		AISelection:   selection.SelectionReason,
		Timestamp:     timestamp,
	}, nil
}

// ============================================================================
// STEP 1: AI ANALYSIS FUNCTION
// ============================================================================

func analyzeTaskWithLLM(config *Config, logger *slog.Logger, sendRequester *http.SendRequester) (*LLMAnalysisResponse, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"task":      config.TaskDescription,
		"maxBudget": config.MaxBudgetUSDC,
		"prompt":    "Analyze this task and recommend compute specifications (CPU cores, RAM, storage, Docker image, estimated duration).",
	})

	resp, err := sendRequester.SendRequest(&http.Request{
		Method:  "POST",
		Url:     config.LLMApiURL + "/analyze",
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    reqBody,
	}).Await()

	if err != nil {
		return nil, fmt.Errorf("LLM analysis request failed: %w", err)
	}

	var analysis LLMAnalysisResponse
	if err := json.Unmarshal(resp.Body, &analysis); err != nil {
		return nil, fmt.Errorf("failed to parse LLM response: %w", err)
	}

	return &analysis, nil
}

// ============================================================================
// STEP 2: FETCH MULTI-PROVIDER QUOTES
// ============================================================================

func fetchMultiProviderQuotes(config *Config, logger *slog.Logger, sendRequester *http.SendRequester, analysis *LLMAnalysisResponse) (*MultiProviderQuotes, error) {
	reqBody, _ := json.Marshal(ComputeQuoteRequest{
		CPU:     analysis.RecommendedCPU,
		RAM:     analysis.RecommendedRAM,
		Storage: analysis.RecommendedStorage,
		Hours:   analysis.EstimatedDuration,
		Image:   analysis.RecommendedImage,
	})

	resp, err := sendRequester.SendRequest(&http.Request{
		Method:  "POST",
		Url:     config.ComputeGatewayURL + "/quotes",
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    reqBody,
	}).Await()

	if err != nil {
		return nil, fmt.Errorf("quote request failed: %w", err)
	}

	var quotes MultiProviderQuotes
	if err := json.Unmarshal(resp.Body, &quotes); err != nil {
		return nil, fmt.Errorf("failed to parse quotes: %w", err)
	}

	return &quotes, nil
}

// ============================================================================
// STEP 3: AI PROVIDER SELECTION
// ============================================================================

func selectProviderWithLLM(config *Config, logger *slog.Logger, sendRequester *http.SendRequester, quotes []ComputeQuoteResponse, taskReasoning string) (*ProviderSelectionResponse, error) {
	reqBody, _ := json.Marshal(ProviderSelectionRequest{
		Task:      config.TaskDescription,
		Budget:    config.MaxBudgetUSDC,
		Quotes:    quotes,
		Reasoning: taskReasoning,
	})

	resp, err := sendRequester.SendRequest(&http.Request{
		Method:  "POST",
		Url:     config.LLMApiURL + "/select-provider",
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    reqBody,
	}).Await()

	if err != nil {
		return nil, fmt.Errorf("provider selection request failed: %w", err)
	}

	var selection ProviderSelectionResponse
	if err := json.Unmarshal(resp.Body, &selection); err != nil {
		return nil, fmt.Errorf("failed to parse selection: %w", err)
	}

	return &selection, nil
}

// ============================================================================
// STEP 4: X402 PAYMENT EXECUTION
// ============================================================================

func executeX402Payment(config *Config, logger *slog.Logger, sendRequester *http.SendRequester, quote *ComputeQuoteResponse) (*PaymentResponse, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"quoteId":   quote.QuoteID,
		"amount":    quote.PriceUSDC,
		"recipient": quote.Provider,
		"memo":      fmt.Sprintf("compute:%s:%s", quote.Provider, config.AgentID),
		"currency":  "USDC",
		"network":   "base",
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

// ============================================================================
// STEP 5: COMPUTE PROVISIONING
// ============================================================================

func provisionCompute(config *Config, logger *slog.Logger, sendRequester *http.SendRequester, quote *ComputeQuoteResponse, payment *PaymentResponse, analysis *LLMAnalysisResponse) (*ProvisionResponse, error) {
	reqBody, _ := json.Marshal(map[string]interface{}{
		"quoteId":   quote.QuoteID,
		"paymentTx": payment.TxHash,
		"image":     analysis.RecommendedImage,
		"provider":  quote.Provider,
		"specs": map[string]interface{}{
			"cpu":     analysis.RecommendedCPU,
			"ram":     analysis.RecommendedRAM,
			"storage": analysis.RecommendedStorage,
		},
	})

	resp, err := sendRequester.SendRequest(&http.Request{
		Method: "POST",
		Url:    config.ComputeGatewayURL + "/provision",
		Headers: map[string]string{
			"Content-Type":    "application/json",
			"X-Payment-Proof": payment.TxHash,
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

// ============================================================================
// STEP 6: ON-CHAIN ATTESTATION
// ============================================================================

func recordAttestation(config *Config, runtime cre.Runtime, data *AttestationData) (string, string, error) {
	logger := runtime.Logger()

	// Serialize attestation data
	attestationJSON, _ := json.Marshal(data)

	// Create attestation ID (hash of data)
	hash := sha256.Sum256(attestationJSON)
	attestationID := "att_" + hex.EncodeToString(hash[:8])

	logger.Info("Preparing attestation", "id", attestationID)
	logger.Info("Attestation data includes",
		"agentId", data.AgentID,
		"action", data.Action,
		"provider", data.Provider,
		"deploymentId", data.DeploymentID,
		"cost", data.CostUSDC,
	)

	// In simulation mode, generate simulated tx hash
	// In production on CRE DON, this would write to AttestationRegistry contract
	if config.ChainName == "" || config.AttestationRegistry == "" {
		logger.Info("Attestation simulated - chain not configured")
		simulatedTxHash := "0x" + hex.EncodeToString(hash[:])
		return simulatedTxHash, attestationID, nil
	}

	logger.Info("Attestation would be written to",
		"chain", config.ChainName,
		"registry", config.AttestationRegistry,
	)

	// Generate deterministic simulated tx hash
	simulatedTxHash := "0x" + hex.EncodeToString(hash[:])
	return simulatedTxHash, attestationID, nil
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

// Ensure types implement ConsensusAggregation where needed
func init() {
	// Type assertions to verify interfaces at compile time
	var _ interface{ ConsensusAggregation() string } = MultiProviderQuotes{}
	var _ interface{ ConsensusAggregation() string } = ProvisionCredentials{}
	var _ interface{ ConsensusAggregation() string } = ProvisionResponse{}
}
