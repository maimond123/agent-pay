import { Router, Request, Response, NextFunction } from 'express';
import { createChildLogger } from '../logger.js';

const logger = createChildLogger('llm-routes');
const router = Router();

// ============================================================================
// LLM API ENDPOINTS (Mock/Simulation for CRE Workflow)
// ============================================================================
// These endpoints simulate LLM responses for task analysis and provider selection
// In production, these would call real LLM APIs (OpenAI, Anthropic, etc.)

// POST /llm/analyze - Analyze task and recommend compute specs
router.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { task, maxBudget } = req.body;
    logger.info({ task: task?.substring(0, 50), maxBudget }, 'LLM analyze request');

    const taskLower = (task || '').toLowerCase();

    let analysis = {
      recommendedCpu: 2,
      recommendedRam: '4GB',
      recommendedStorage: '10GB',
      recommendedImage: 'python:3.11',
      estimatedDurationHours: 1,
      reasoning: '',
      confidence: 'high',
    };

    // Analyze task keywords to determine compute requirements
    if (taskLower.includes('machine learning') || taskLower.includes('ml') || taskLower.includes('training')) {
      analysis = {
        recommendedCpu: 4,
        recommendedRam: '16GB',
        recommendedStorage: '50GB',
        recommendedImage: 'pytorch/pytorch:latest',
        estimatedDurationHours: 4,
        reasoning: 'Machine learning task detected. Recommending higher CPU cores and RAM for training workloads. PyTorch image selected for ML frameworks. Extended duration for training epochs.',
        confidence: 'high',
      };
    } else if (taskLower.includes('web') || taskLower.includes('api') || taskLower.includes('server')) {
      analysis = {
        recommendedCpu: 2,
        recommendedRam: '4GB',
        recommendedStorage: '20GB',
        recommendedImage: 'node:20-alpine',
        estimatedDurationHours: 24,
        reasoning: 'Web service task detected. Moderate resources sufficient for API hosting. Node.js image for JavaScript/TypeScript workloads.',
        confidence: 'high',
      };
    } else if (taskLower.includes('data') || taskLower.includes('analysis') || taskLower.includes('pandas')) {
      analysis = {
        recommendedCpu: 4,
        recommendedRam: '8GB',
        recommendedStorage: '100GB',
        recommendedImage: 'jupyter/scipy-notebook',
        estimatedDurationHours: 2,
        reasoning: 'Data analysis task detected. Higher memory for data processing. Large storage for datasets.',
        confidence: 'medium',
      };
    } else if (taskLower.includes('gpu') || taskLower.includes('cuda') || taskLower.includes('render')) {
      analysis = {
        recommendedCpu: 8,
        recommendedRam: '32GB',
        recommendedStorage: '100GB',
        recommendedImage: 'nvidia/cuda:12.0-runtime-ubuntu22.04',
        estimatedDurationHours: 6,
        reasoning: 'GPU workload detected. High resources required for CUDA operations.',
        confidence: 'high',
      };
    } else {
      analysis.reasoning = 'General compute task. Default configuration with Python runtime.';
      analysis.confidence = 'medium';
    }

    logger.info({ analysis: { cpu: analysis.recommendedCpu, ram: analysis.recommendedRam } }, 'LLM analysis complete');
    return res.json(analysis);
  } catch (error) {
    next(error);
  }
});

// POST /llm/select-provider - Select best provider from quotes
router.post('/select-provider', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { task, budget, quotes, reasoning } = req.body;

    // Handle both array and {quotes: [...]} formats
    let quotesArray: any[] = [];
    if (Array.isArray(quotes)) {
      quotesArray = quotes;
    } else if (quotes && typeof quotes === 'object' && Array.isArray(quotes.quotes)) {
      quotesArray = quotes.quotes;
    }

    logger.info({ task: task?.substring(0, 30), budget, quoteCount: quotesArray.length }, 'LLM select-provider request');
    const maxBudget = parseFloat(budget) || 100;

    // Filter quotes within budget
    const validQuotes = quotesArray.filter((q: any) => {
      const price = parseFloat(q.priceUsdc || q.pricing?.totalUsdc || '0');
      return price <= maxBudget;
    });

    if (validQuotes.length === 0) {
      return res.json({
        selectedProvider: null,
        selectedQuoteId: null,
        selectionReason: 'No providers within budget',
        confidence: 'low',
      });
    }

    // Sort by price and select cheapest
    const sorted = validQuotes.sort((a: any, b: any) => {
      const priceA = parseFloat(a.priceUsdc || a.pricing?.totalUsdc || '0');
      const priceB = parseFloat(b.priceUsdc || b.pricing?.totalUsdc || '0');
      return priceA - priceB;
    });

    const selected = sorted[0];
    const selectedPrice = selected.priceUsdc || (parseInt(selected.pricing?.totalUsdc || '0') / 1_000_000).toFixed(2);

    const response = {
      selectedProvider: selected.provider || selected.providerName,
      selectedQuoteId: selected.quoteId,
      selectionReason: `Selected ${selected.provider || selected.providerName} as the most cost-effective option at $${selectedPrice} USDC. Provider offers ${selected.capabilities || 'standard'} capabilities suitable for the task.`,
      confidence: 'high',
    };

    logger.info({ selected: response.selectedProvider, quoteId: response.selectedQuoteId }, 'LLM selection complete');
    return res.json(response);
  } catch (error) {
    next(error);
  }
});

export default router;
