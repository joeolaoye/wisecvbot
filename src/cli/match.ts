import { checkConnection, closeDb } from '../storage/db.js'
import { runDailyMatch } from '../matching/orchestrator.js'
import { logger } from '../log.js'

/** One match run: for every active subscriber → tier 1/2/3 → deliver. */
async function main() {
  await checkConnection()
  const summary = await runDailyMatch({
    // console mode — with a bot token configured, src/main.ts delivers via Telegram
    async deliverMatch(subscriber, job, review) {
      console.log(
        `[would send → subscriber ${subscriber.id}] ${job.title} @ ${job.company} (fit ${review.fitScore})`,
      )
      return true
    },
  })
  console.table(summary)
  await closeDb()
}

main().catch((err) => {
  logger.error('fatal', { error: String(err).slice(0, 500) })
  process.exit(1)
})
