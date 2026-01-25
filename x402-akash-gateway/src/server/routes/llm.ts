import { Router, Request, Response, NextFunction } from 'express';
import { createChildLogger } from '../logger.js';

const logger = createChildLogger('llm-routes');
const router = Router();

// ============================================================================
// LLM PROVIDER CONFIGURATION
// ============================================================================

interface LLMConfig {
  provider: 'openai' | 'anthropic' | 'mock';
  apiKey?: string;
  model?: string;
}

function getLLMConfig(): LLMConfig {
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
    };
  }
  return { provider: 'mock' };
}

// ============================================================================
// OPENAI API INTEGRATION
// ============================================================================

async function callOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json() as any;
  return data.choices[0]?.message?.content || '';
}

// ============================================================================
// ANTHROPIC API INTEGRATION
// ============================================================================

async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${error}`);
  }

  const data = await response.json() as any;
  return data.content[0]?.text || '';
}

// ============================================================================
// LLM CALL WRAPPER
// ============================================================================

async function callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  const config = getLLMConfig();

  if (config.provider === 'openai' && config.apiKey) {
    logger.debug({ model: config.model }, 'Calling OpenAI');
    return callOpenAI(config.apiKey, config.model!, systemPrompt, userPrompt);
  }

  if (config.provider === 'anthropic' && config.apiKey) {
    logger.debug({ model: config.model }, 'Calling Anthropic');
    return callAnthropic(config.apiKey, config.model!, systemPrompt, userPrompt);
  }

  // Mock mode - return empty to trigger fallback
  return '';
}

// ============================================================================
// ANALYZE ENDPOINT - Task analysis with LLM
// ============================================================================

const ANALYZE_SYSTEM_PROMPT = `You are an AI that analyzes compute tasks and recommends cloud resources.

Given a task description, respond with a JSON object containing:
- recommendedCpu: number (1-16 cores)
- recommendedRam: string (e.g., "4GB", "16GB", "32GB")
- recommendedStorage: string (e.g., "10GB", "50GB", "100GB")
- recommendedImage: string (Docker image name)
- estimatedDurationHours: number (1-48)
- reasoning: string (brief explanation)
- confidence: "high" | "medium" | "low"

Common images:
- python:3.11 (general Python)
- pytorch/pytorch:latest (ML/AI training)
- node:20-alpine (web services)
- jupyter/scipy-notebook (data analysis)
- nvidia/cuda:12.0-runtime-ubuntu22.04 (GPU workloads)

Respond ONLY with valid JSON, no markdown or explanation.`;

router.post('/analyze', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { task, maxBudget } = req.body;
    logger.info({ task: task?.substring(0, 50), maxBudget }, 'LLM analyze request');

    const config = getLLMConfig();
    let analysis: any = null;

    // Try real LLM first
    if (config.provider !== 'mock') {
      try {
        const userPrompt = `Analyze this compute task and recommend resources:

Task: ${task}
Max Budget: $${maxBudget} USDC

Respond with JSON only.`;

        const llmResponse = await callLLM(ANALYZE_SYSTEM_PROMPT, userPrompt);
        if (llmResponse) {
          // Extract JSON from response (handle markdown code blocks)
          const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            analysis = JSON.parse(jsonMatch[0]);
            logger.info({ provider: config.provider, model: config.model }, 'LLM analysis from real provider');
          }
        }
      } catch (error) {
        logger.warn({ error }, 'LLM API call failed, falling back to keyword analysis');
      }
    }

    // Fallback to keyword-based analysis
    if (!analysis) {
      const taskLower = (task || '').toLowerCase();

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
        analysis = {
          recommendedCpu: 2,
          recommendedRam: '4GB',
          recommendedStorage: '10GB',
          recommendedImage: 'python:3.11',
          estimatedDurationHours: 1,
          reasoning: 'General compute task. Default configuration with Python runtime.',
          confidence: 'medium',
        };
      }
    }

    logger.info({ analysis: { cpu: analysis.recommendedCpu, ram: analysis.recommendedRam } }, 'LLM analysis complete');
    return res.json(analysis);
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// SELECT-PROVIDER ENDPOINT - Provider selection with LLM
// ============================================================================

const SELECT_SYSTEM_PROMPT = `You are an AI that selects optimal cloud compute providers.

Given a list of provider quotes and task requirements, respond with a JSON object:
- selectedProvider: string (provider ID)
- selectedQuoteId: string (quote ID)
- selectionReason: string (brief explanation of why this provider was chosen)
- confidence: "high" | "medium" | "low"

Consider: price, capabilities, region, and suitability for the task.
Respond ONLY with valid JSON, no markdown or explanation.`;

router.post('/select-provider', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { task, budget, quotes } = req.body;

    // Handle both array and {quotes: [...]} formats
    let quotesArray: any[] = [];
    if (Array.isArray(quotes)) {
      quotesArray = quotes;
    } else if (quotes && typeof quotes === 'object' && Array.isArray(quotes.quotes)) {
      quotesArray = quotes.quotes;
    }

    logger.info({ task: task?.substring(0, 30), budget, quoteCount: quotesArray.length }, 'LLM select-provider request');
    const maxBudget = parseFloat(budget) || 100;

    const config = getLLMConfig();
    let selection: any = null;

    // Try real LLM first
    if (config.provider !== 'mock' && quotesArray.length > 0) {
      try {
        const quoteSummary = quotesArray.map(q => ({
          provider: q.provider || q.providerName,
          quoteId: q.quoteId,
          price: q.priceUsdc || (parseInt(q.pricing?.totalUsdc || '0') / 1_000_000).toFixed(2),
          capabilities: q.capabilities,
          region: q.region,
        }));

        const userPrompt = `Select the best provider for this task:

Task: ${task}
Budget: $${budget} USDC

Available Quotes:
${JSON.stringify(quoteSummary, null, 2)}

Respond with JSON only.`;

        const llmResponse = await callLLM(SELECT_SYSTEM_PROMPT, userPrompt);
        if (llmResponse) {
          const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            selection = JSON.parse(jsonMatch[0]);
            logger.info({ provider: config.provider }, 'Provider selection from real LLM');
          }
        }
      } catch (error) {
        logger.warn({ error }, 'LLM API call failed, falling back to price-based selection');
      }
    }

    // Fallback to price-based selection
    if (!selection) {
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

      selection = {
        selectedProvider: selected.provider || selected.providerName,
        selectedQuoteId: selected.quoteId,
        selectionReason: `Selected ${selected.provider || selected.providerName} as the most cost-effective option at $${selectedPrice} USDC. Provider offers ${selected.capabilities || 'standard'} capabilities suitable for the task.`,
        confidence: 'high',
      };
    }

    logger.info({ selected: selection.selectedProvider, quoteId: selection.selectedQuoteId }, 'LLM selection complete');
    return res.json(selection);
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// CONFIG ENDPOINT - Check LLM configuration
// ============================================================================

router.get('/config', async (req: Request, res: Response) => {
  const config = getLLMConfig();
  return res.json({
    provider: config.provider,
    model: config.model || 'N/A',
    status: config.provider === 'mock' ? 'Using keyword-based analysis (no API key set)' : 'Using real LLM',
  });
});

export default router;
