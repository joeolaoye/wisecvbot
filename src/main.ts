import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { checkConnection, closeDb, db } from './storage/db.js'
import { createBot, telegramNotifier } from './channels/telegram.js'
import { env, requireBotEnv } from './config/env.js'
import { logger } from './log.js'
import { schedulerIdle, startScheduler } from './scheduler.js'
import { startServer } from './server.js'

async function main(): Promise<void> {
  await checkConnection()
  // migrations ship in the image and apply at boot — idempotent, journal-tracked,
  // so a fresh self-hosted stack never runs against missing tables
  await migrate(db, { migrationsFolder: 'drizzle' })
  logger.info('migrations_applied', { env: env.NODE_ENV })

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

  const shutdown = async (signal: string) => {
    logger.info('shutting_down', { signal })
    await bot.stop()
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

requireBotEnv() // fail loud before anything else when the token is missing
main().catch((err) => {
  logger.error('fatal', { error: String(err).slice(0, 500) })
  process.exit(1)
})
