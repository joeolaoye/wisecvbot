import { checkConnection, closeDb } from '../storage/db.js'
import { runDailyMatch } from '../matching/orchestrator.js'
import { createBot, telegramNotifier } from '../channels/telegram.js'
import { env } from '../config/env.js'
import { logger } from '../log.js'
import type { Notifier } from '../channels/base.js'

/** One match run: for every active subscriber → tier 1/2/3 → deliver. */
async function main() {
  await checkConnection()

  // with a bot token configured this CLI delivers for real; without one it
  // stays a dry-run (the running app's scheduler always delivers for real)
  let notifier: Notifier
  if (env.TELEGRAM_BOT_TOKEN) {
    notifier = telegramNotifier(createBot())
    logger.info('match_cli_mode', { mode: 'telegram-delivery' })
  } else {
    notifier = {
      async deliverMatch(subscriber, job, review) {
        console.log(
          `[would send → subscriber ${subscriber.id}] ${job.title} @ ${job.company} (fit ${review.fitScore})`,
        )
        return true
      },
    }
    logger.info('match_cli_mode', { mode: 'dry-run (no TELEGRAM_BOT_TOKEN)' })
  }

  const summary = await runDailyMatch(notifier)
  console.table(summary)
  await closeDb()
}

main().catch((err) => {
  logger.error('fatal', { error: String(err).slice(0, 500) })
  process.exit(1)
})
