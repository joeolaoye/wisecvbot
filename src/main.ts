import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { checkConnection, closeDb, db, pool } from './storage/db.js'
import { createBot, telegramNotifier } from './channels/telegram.js'
import { env } from './config/env.js'
import type { Notifier } from './channels/base.js'
import { logger } from './log.js'
import { schedulerIdle, startScheduler } from './scheduler.js'
import { startServer } from './server.js'

async function main(): Promise<void> {
  await checkConnection()
  // pgvector must exist before migrations (no-op on the compose image; required
  // on external databases where the extension isn't enabled by default)
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector')
  // migrations ship in the image and apply at boot — idempotent, journal-tracked,
  // so a fresh self-hosted stack never runs against missing tables
  await migrate(db, { migrationsFolder: 'drizzle' })
  logger.info('migrations_applied', { env: env.NODE_ENV })

  if (env.TELEGRAM_BOT_TOKEN) {
    const bot = createBot()
    const notifier = telegramNotifier(bot)
    startServer(bot)
    startScheduler(notifier)

    if (env.APP_URL) {
      // production: webhook mode (Caddy terminates TLS in front)
      const url = `${env.APP_URL}/${env.TELEGRAM_WEBHOOK_PATH.replace(/^\//, '')}`
      await bot.api.setWebhook(url, { secret_token: env.TELEGRAM_WEBHOOK_SECRET })
      logger.info('webhook_registered', { url })
    } else {
      // dev: long polling — no public URL needed
      void bot.start({
        onStart: () => logger.info('bot_started_polling'),
      })
    }
  } else {
    // headless mode: ingestion + matching bookkeeping + healthz, no bot.
    // Useful for local testing and for operators who only want the pipeline.
    logger.warn('headless_mode', { note: 'no TELEGRAM_BOT_TOKEN — ingest + healthz only' })
    const headlessNotifier: Notifier = {
      async deliverMatch(sub, job, review, matchId) {
        logger.info('headless_match_delivered', {
          subscriberId: sub.id,
          jobId: job.id,
          matchId,
          fitScore: review.fitScore,
        })
        return true
      },
    }
    startServer()
    startScheduler(headlessNotifier)
  }

  const shutdown = async (signal: string) => {
    logger.info('shutting_down', { signal })
    // give an in-flight scheduled run a brief window to finish so a SIGTERM
    // mid-broadcast doesn't orphan deliveries (they'd retry as `pending`)
    for (let i = 0; i < 20 && !schedulerIdle(); i++) {
      await new Promise((r) => setTimeout(r, 500))
    }
    await closeDb()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.error('fatal', { error: String(err).slice(0, 500) })
  process.exit(1)
})
