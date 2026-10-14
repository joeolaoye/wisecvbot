import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { embedMany, generateObject, type EmbeddingModel, type LanguageModel } from 'ai'
import type { z } from 'zod'
import { env, type LlmProvider } from './config/env.js'
import { logger } from './log.js'
import { addSpend, spendCentsToday } from './storage/ops.js'

/**
 * Central LLM access behind a small provider registry. Out of the gate:
 * OpenAI (default) and Anthropic/Claude. Adding a provider = one entry in
 * PROVIDER_DEFAULT_CHAT + one case in chatModel() + its @ai-sdk/* package.
 *
 * Split responsibilities:
 *  - CHAT/review runs on LLM_PROVIDER (openai | anthropic)
 *  - EMBEDDINGS always run on the OpenAI-compatible provider — Anthropic has
 *    no embeddings API. Point OPENAI_BASE_URL at Ollama for fully-local.
 *
 * Every call passes the hard daily budget gate first; past the cap, calls
 * are skipped (never alerted-then-run) and the pipeline degrades gracefully.
 */

export class LlmUnavailableError extends Error {
  constructor(
    public reason: 'not-configured' | 'budget-exhausted',
  ) {
    super(reason)
  }
}

/** Per-provider fallback when CHAT_MODEL is not set. */
export const PROVIDER_DEFAULT_CHAT: Record<LlmProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
}

export function resolveChatModelId(provider: LlmProvider, override?: string): string {
  return override ?? PROVIDER_DEFAULT_CHAT[provider]!
}

function openaiClient() {
  return createOpenAI({
    apiKey: env.OPENAI_API_KEY ?? 'missing',
    baseURL: env.OPENAI_BASE_URL,
  })
}

function chatModel(): LanguageModel {
  const modelId = resolveChatModelId(env.LLM_PROVIDER, env.CHAT_MODEL)
  switch (env.LLM_PROVIDER) {
    case 'anthropic':
      return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY ?? 'missing' }).languageModel(modelId)
    case 'openai':
    default:
      return openaiClient().languageModel(modelId)
  }
}

function embeddingModel(): EmbeddingModel {
  return openaiClient().textEmbeddingModel(env.EMBEDDING_MODEL)
}

/** The active chat provider has credentials. */
export function llmConfigured(): boolean {
  return env.LLM_PROVIDER === 'anthropic'
    ? Boolean(env.ANTHROPIC_API_KEY)
    : Boolean(env.OPENAI_API_KEY)
}

/** Embeddings have a usable provider (OpenAI-compatible key or local endpoint). */
export function embeddingsConfigured(): boolean {
  return Boolean(env.OPENAI_API_KEY) || Boolean(env.OPENAI_BASE_URL)
}

/** Every provider call carries a hard timeout — a hung provider must never hang the pipeline. */
const LLM_TIMEOUT_MS = 60_000

async function ensureBudget(configured: boolean): Promise<void> {
  if (!configured) throw new LlmUnavailableError('not-configured')
  const spent = await spendCentsToday()
  if (spent >= env.DAILY_LLM_BUDGET_CENTS) {
    logger.warn('llm_budget_exhausted', { spentCents: spent, budgetCents: env.DAILY_LLM_BUDGET_CENTS })
    throw new LlmUnavailableError('budget-exhausted')
  }
}

function costCents(totalTokens: number): number {
  // env-configurable estimate; defaults conservative (over-estimates = safe side)
  return Math.max(1, Math.ceil((totalTokens / 1000) * env.LLM_CENTS_PER_1K_TOKENS))
}

export async function generateJson<T>(schema: z.ZodType<T>, system: string, prompt: string): Promise<T> {
  await ensureBudget(llmConfigured())
  const result = await generateObject({
    model: chatModel(),
    schema,
    system,
    prompt,
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })
  const total = result.usage?.totalTokens ?? 0
  await addSpend(costCents(total))
  return result.object
}

export async function embedTexts(values: string[]): Promise<number[][]> {
  if (values.length === 0) return []
  await ensureBudget(embeddingsConfigured())
  const result = await embedMany({
    model: embeddingModel(),
    values,
    abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  })
  await addSpend(costCents(result.usage?.tokens ?? values.length * 800))
  return result.embeddings
}

export async function embedText(value: string): Promise<number[]> {
  const [vector] = await embedTexts([value])
  if (!vector) throw new Error('embedding provider returned no vector')
  return vector
}
