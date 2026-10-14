import cron from 'node-cron'
import { env } from './config/env.js'
import { runIngestion } from './ingestion/index.js'
import { logger } from './log.js'
import { runDailyMatch } from './matching/orchestrator.js'
import type { Notifier } from './channels/base.js'

/** Hourly find (ingest) + daily sort-and-deliver (match) — architecture §3. */
export function startScheduler(notifier: Notifier): void {
  cron.schedule(env.INGEST_CRON, async () => {
    try {
      await runIngestion()
    } catch (err) {
      logger.error('scheduled_ingest_failed', { error: String(err).slice(0, 300) })
    }
  })

  cron.schedule(env.MATCH_CRON, async () => {
    try {
      await runDailyMatch(notifier)
    } catch (err) {
      logger.error('scheduled_match_failed', { error: String(err).slice(0, 300) })
    }
  })

  logger.info('scheduler_started', { ingest: env.INGEST_CRON, match: env.MATCH_CRON })
}
