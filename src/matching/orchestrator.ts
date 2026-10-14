import { env } from '../config/env.js'
import type { Notifier } from '../channels/base.js'
import { logger } from '../log.js'
import { embedProfile } from '../pipeline/embed.js'
import type { Job } from '../storage/schema.js'
import { jobsSince } from '../storage/jobs.js'
import { countSentToday, createMatch, logEvent, matchedJobIds } from '../storage/ops.js'
import { activeSubscribers, setEmbedding } from '../storage/subscribers.js'
import { tier1Filter } from './tier1-filters.js'
import { tier2Rank } from './tier2-embeddings.js'
import { fallbackReview, reviewFit } from './tier3-review.js'

const CANDIDATE_WINDOW_DAYS = 7
const NO_RESEND_DAYS = 14
const TIER2_TOP_K = 5

export interface MatchRunSummary {
  subscribersConsidered: number
  alertsSent: number
  reviewsRun: number
}

/**
 * The daily engine loop: find → sort → deliver (journey doc §3).
 * Reads ONLY the ratified profile (sub.profile) — never raw CVs.
 */
export async function runDailyMatch(notifier: Notifier): Promise<MatchRunSummary> {
  const summary: MatchRunSummary = { subscribersConsidered: 0, alertsSent: 0, reviewsRun: 0 }

  const subscribers = await activeSubscribers()
  const candidates = await jobsSince(new Date(Date.now() - CANDIDATE_WINDOW_DAYS * 86_400_000))

  for (const sub of subscribers) {
    const profile = sub.profile
    if (!profile) continue
    summary.subscribersConsidered++

    const allowance = env.MAX_MATCH_ALERTS_PER_DAY - (await countSentToday(sub.id))
    if (allowance <= 0) continue

    const exclude = new Set(await matchedJobIds(sub.id, NO_RESEND_DAYS))
    const filtered = candidates.filter((j) => !exclude.has(j.id) && tier1Filter(profile, j))

    let embedding = sub.profileEmbedding
    if (!embedding) {
      embedding = await embedProfile(profile)
      if (embedding) await setEmbedding(sub.id, embedding)
    }

    // ranked by tier 2; when embeddings are unavailable (no key), fall back to
    // tier-1-passing recency order — reviews still gate delivery
    const ranked: Array<{ job: Job; simScore: number }> = embedding
      ? tier2Rank(embedding, filtered, { threshold: sub.matchThreshold, k: TIER2_TOP_K })
      : filtered.slice(0, TIER2_TOP_K).map((job) => ({ job, simScore: 0 }))

    let sent = 0
    for (const cand of ranked) {
      if (sent >= allowance) break

      const review = await reviewFit(profile, cand.job)
      if (review) summary.reviewsRun++
      const effective = review ?? fallbackReview(cand.simScore, cand.job)
      if (!effective.match) continue

      const matchId = await createMatch({
        subscriberId: sub.id,
        jobId: cand.job.id,
        simScore: cand.simScore,
        fitScore: effective.fitScore,
        rationale: effective,
      })
      if (matchId === null) continue // already sent at some point

      const delivered = await notifier.deliverMatch(sub, cand.job, effective, matchId)
      if (delivered) {
        sent++
        summary.alertsSent++
      } else {
        logger.error('deliver_failed', { subscriberId: sub.id, jobId: cand.job.id })
      }
    }
  }

  await logEvent(null, 'match_run', { ...summary })
  logger.info('match_run', { ...summary })
  return summary
}
