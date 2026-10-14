import { z } from 'zod'

/**
 * All configuration comes from the environment — no config files with secrets.
 * The app refuses to boot on missing/invalid values (architecture §8: fail loud,
 * never default-open).
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1),
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Public HTTPS URL; when set, the bot registers a Telegram webhook. */
  APP_URL: z.string().optional(),
  TELEGRAM_WEBHOOK_PATH: z
    .string()
    .regex(/^[a-z0-9/-]+$/)
    .default('telegram/webhook'),

  /** Required for bot / match-delivery mode only. */
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  /** 32 bytes base64 — generate with: openssl rand -base64 32 */
  CV_ENCRYPTION_KEY: z.string().min(40),

  // LLM (OpenAI-compatible; set OPENAI_BASE_URL to an Ollama endpoint for fully-local)
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  CHAT_MODEL: z.string().default('gpt-4o-mini'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  DAILY_LLM_BUDGET_CENTS: z.coerce.number().int().min(0).default(500),
  /** Conservative cost estimate for budget accounting (default over-estimates, which is the safe side). */
  LLM_CENTS_PER_1K_TOKENS: z.coerce.number().positive().default(1),

  MAX_MATCH_ALERTS_PER_DAY: z.coerce.number().int().min(1).max(10).default(3),

  INGEST_CRON: z.string().default('0 * * * *'),
  MATCH_CRON: z.string().default('30 9 * * *'),

  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

function loadEnvFileOnce() {
  if (process.env.WISECV_ENV_LOADED) return
  try {
    process.loadEnvFile('.env')
  } catch {
    // no .env — real environment only (CI, compose)
  }
  process.env.WISECV_ENV_LOADED = '1'
}

function parseEnv(): z.infer<typeof envSchema> {
  loadEnvFileOnce()
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}\nCopy .env.example to .env and fill it in.`)
  }
  const env = parsed.data
  // webhook mode is a public endpoint — refuse to run it unauthenticated
  // (grammY accepts ALL requests when the secret token is undefined)
  if (env.APP_URL && !env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET is required when APP_URL is set (webhook mode). Generate: openssl rand -hex 32')
  }
  // key material must actually decode to 32 bytes, not just be long
  const key = Buffer.from(env.CV_ENCRYPTION_KEY, 'base64')
  if (key.length !== 32) {
    throw new Error('CV_ENCRYPTION_KEY must be 32 bytes base64 — generate with: openssl rand -base64 32')
  }
  return env
}

export const env = parseEnv()

/** Bot mode needs a token; ingest/match CLIs do not. */
export function requireBotEnv() {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required for bot mode')
  return env.TELEGRAM_BOT_TOKEN
}

/** LLM-backed steps (extraction, embeddings, tier-3 review) degrade gracefully without a key. */
export function llmConfigured(): boolean {
  return Boolean(env.OPENAI_API_KEY)
}
