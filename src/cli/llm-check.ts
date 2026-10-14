import { z } from 'zod'
import { env } from '../config/env.js'
import { closeDb } from '../storage/db.js'
import { embedTexts, generateJson, embeddingsConfigured, llmConfigured } from '../llm.js'
import { logger } from '../log.js'

/**
 * Verify the LLM configuration without the bot: one tiny structured call on
 * the active chat provider + one embedding. Run: npm run llm:check
 */
async function main() {
  console.log(`provider:        ${env.LLM_PROVIDER}`)
  console.log(`chat configured:  ${llmConfigured()}`)
  console.log(`embed configured: ${embeddingsConfigured()}`)
  console.log(`chat model:       ${env.CHAT_MODEL ?? '(provider default)'}`)
  console.log(`embed model:      ${env.EMBEDDING_MODEL}\n`)

  if (llmConfigured()) {
    const out = await generateJson(
      z.object({ ok: z.boolean(), note: z.string().max(20) }),
      'You are a health check. Reply exactly as instructed.',
      'Set ok=true and note="chat path works".',
    )
    console.log('chat roundtrip:  ✓', JSON.stringify(out))
  } else {
    console.log('chat roundtrip:  skipped (no key for the active provider)')
  }

  if (embeddingsConfigured()) {
    const [vec] = await embedTexts(['senior backend engineer, python, aws'])
    console.log(`embedding:       ✓ ${vec?.length ?? 0} dimensions`)
    if (vec && vec.length !== 1536) {
      console.log('  ⚠ dimensions ≠ 1536 — the schema expects 1536; set EMBEDDING_MODEL accordingly')
    }
  } else {
    console.log('embedding:       skipped (no OpenAI-compatible key/base URL)')
  }

  await closeDb()
}

main().catch((err) => {
  logger.error('fatal', { error: String(err).slice(0, 400) })
  process.exit(1)
})
