import { createOpenAI } from '@ai-sdk/openai'
import { embedMany, generateObject } from 'ai'
import type { z } from 'zod'
import { env, llmConfigured } from './config/env.js'
import { logger } from './log.js'
import { addSpend, spendCentsToday } from './storage/ops.js'

/**
 * Central LLM access: one provider (OpenAI-compatible — point OPENAI_BASE_URL at
 * Ollama for fully-local), one hard daily budget gate checked before every call.
 * Self-hosters swap providers with one env var; nothing else changes.
 */

export class LlmUnavailableError extends Error {
  constructor(
    public reason: 'not-configured' | 'budget-exhausted',
  ) {
    super(reason)
  }
}

function provider() {
  return createOpenAI({
    apiKey: env.OPENAI_API_KEY ?? 'missing',
    baseURL: env.OPENAI_BASE_URL,
  })
}

function chatModel() {
  return provider().languageModel(env.CHAT_MODEL)
}

function embeddingModel() {
  return provider().textEmbeddingModel(env.EMBEDDING_MODEL)
}

/** Conservative cents-per-1k-tokens for budget accounting (default over-estimates, which is the safe side). */
const CENTS_PER_1K = Number(process.env.LLM_CENTS_PER_1K_TOKENS ?? 1)

async function ensureBudget(): Promise<void> {
  if (!llmConfigured()) throw new LlmUnavailableError('not-configured')
  const spent = await spendCentsToday()
  if (spent >= env.DAILY_LLM_BUDGET_CENTS) {
    logger.warn('llm_budget_exhausted', { spentCents: spent, budgetCents: env.DAILY_LLM_BUDGET_CENTS })
    throw new LlmUnavailableError('budget-exhausted')
  }
}

function costCents(totalTokens: number): number {
  return Math.max(1, Math.ceil((totalTokens / 1000) * CENTS_PER_1K))
}

export async function generateJson<T>(schema: z.ZodType<T>, system: string, prompt: string): Promise<T> {
  await ensureBudget()
  const result = await generateObject({
    model: chatModel(),
    schema,
    system,
    prompt,
  })
  const total = result.usage?.totalTokens ?? 0
  await addSpend(costCents(total))
  return result.object
}

export async function embedTexts(values: string[]): Promise<number[][]> {
  if (values.length === 0) return []
  await ensureBudget()
  const result = await embedMany({ model: embeddingModel(), values })
  await addSpend(costCents(result.usage?.tokens ?? values.length * 800))
  return result.embeddings
}

export async function embedText(value: string): Promise<number[]> {
  const [vector] = await embedTexts([value])
  if (!vector) throw new Error('embedding provider returned no vector')
  return vector
}
