import cron from 'node-cron'
import { env } from './config/env.js'
import { runIngestion } from './ingestion/index.js'
import { logger } from './log.js'
import { runDailyMatch } from './matching/orchestrator.js'
import { pruneEvents } from './storage/ops.js'
import { pruneJobs } from './storage/jobs.js'
import type { Notifier } from './channels/base.js'

const EVENT_RETENTION_DAYS = 90
const JOB_RETENTION_DAYS = 30

const inFlight = { ingest: false, match: false }

/** Wrap a cron task so overlapping ticks skip instead of piling up. */
function guarded(name: keyof typeof inFlight, task: () => Promise<unknown>) {
  return async () => {
    if (inFlight[name]) {
      logger.warn('cron_skipped_overlap', { job: name })
      return
    }
    inFlight[name] = true
    try {
      await task()
    } finally {
      inFlight[name] = false
    }
  }
}

/** Hourly find (ingest) + daily sort-and-deliver (match) + weekly retention. */
export function startScheduler(notifier: Notifier): void {
  cron.schedule(env.INGEST_CRON, guarded('ingest', () => runIngestion()))
  cron.schedule(env.MATCH_CRON, guarded('match', () => runDailyMatch(notifier)))
  cron.schedule(
    '17 4 * * 0',
    guarded('ingest', async () => {
      await pruneEvents(EVENT_RETENTION_DAYS)
      await pruneJobs(JOB_RETENTION_DAYS)
      logger.info('retention_pruned', { eventsDays: EVENT_RETENTION_DAYS, jobsDays: JOB_RETENTION_DAYS })
    }),
  )

  logger.info('scheduler_started', { ingest: env.INGEST_CRON, match: env.MATCH_CRON })
}

/** True when no scheduled job is mid-run (shutdown waits briefly for this). */
export function schedulerIdle(): boolean {
  return !inFlight.ingest && !inFlight.match
}
