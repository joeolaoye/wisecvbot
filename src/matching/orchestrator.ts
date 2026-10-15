import { env } from '../config/env.js'
import type { Notifier } from '../channels/base.js'
import { logger } from '../log.js'
import { embedProfile } from '../pipeline/embed.js'
import { normalizeTitle } from '../pipeline/dedupe.js'
import type { SubscriberLite } from '../storage/subscribers.js'
import { jobsByIds, jobsSince, type JobLite } from '../storage/jobs.js'
import {
  countSentToday,
  createMatch,
  logEvent,
  markSent,
  matchedDedupeKeys,
  matchedJobIds,
  pendingMatches,
} from '../storage/ops.js'
import { activeSubscribers, setEmbedding } from '../storage/subscribers.js'
import { tier1Filter } from './tier1-filters.js'
import { tier2Rank } from './tier2-embeddings.js'
import { fallbackReview, reviewFit } from './tier3-review.js'

const CANDIDATE_WINDOW_DAYS = 7
const NO_RESEND_DAYS = 14
const TIER2_TOP_K = 5
/**
 * Tier 2 RANKS; tier 3 GATES. With short profiles vs long job descriptions,
 * text-embedding similarities for genuinely related content land ~0.4–0.6, so
 * an absolute cutoff here would starve tier 3 — this floor only guards against
 * pure garbage. The subscriber threshold applies to the no-LLM fallback path.
 */
const TIER2_FLOOR = 0.3
/** Without an LLM review, tier-2 evidence must clear a higher bar before delivery. */
const FALLBACK_EXTRA_MARGIN = 0.05

export interface MatchRunSummary {
  subscribersConsidered: number
  alertsSent: number
  reviewsRun: number
  subscribersFailed: number
}

/**
 * The daily engine loop: find → sort → deliver (journey doc §3).
 * Crash-safe: matches are reserved as `pending` and confirmed `sent` only
 * after the channel accepts the delivery — a failed send is retried next run,
 * never permanently burned. Reads ONLY the ratified profile (never raw CVs).
 */
export async function runDailyMatch(notifier: Notifier): Promise<MatchRunSummary> {
  const summary: MatchRunSummary = {
    subscribersConsidered: 0,
    alertsSent: 0,
    reviewsRun: 0,
    subscribersFailed: 0,
  }

  const subscribers = await activeSubscribers()
  const candidates = await jobsSince(new Date(Date.now() - CANDIDATE_WINDOW_DAYS * 86_400_000))

  for (const sub of subscribers) {
    const profile = sub.profile
    if (!profile) continue
    // one subscriber's failure (mid-run /delete, DB blip) must not abort the
    // broadcast for everyone after them
    try {
      summary.subscribersConsidered++
      await runForSubscriber(sub, profile, candidates, notifier, summary)
    } catch (err) {
      summary.subscribersFailed++
      logger.error('match_subscriber_failed', { subscriberId: sub.id, error: String(err).slice(0, 200) })
    }
  }

  await logEvent(null, 'match_run', { ...summary })
  logger.info('match_run', { ...summary })
  return summary
}

async function runForSubscriber(
  sub: SubscriberLite,
  profile: NonNullable<SubscriberLite['profile']>,
  candidates: JobLite[],
  notifier: Notifier,
  summary: MatchRunSummary,
): Promise<void> {
  let allowance = env.MAX_MATCH_ALERTS_PER_DAY - (await countSentToday(sub.id))

  // 1. finish deliveries interrupted by a previous crash/restart first
  //    (rationale is stored on the pending row)
  const pending = await pendingMatches(sub.id)
  if (pending.length > 0 && allowance > 0) {
    const jobs = await jobsByIds(pending.map((p) => p.jobId))
    const byId = new Map(jobs.map((j) => [j.id, j]))
    for (const p of pending) {
      if (allowance <= 0) break
      const job = byId.get(p.jobId)
      if (!job) continue
      const rationale = p.rationale ?? fallbackReview(0, job)
      if (await notifier.deliverMatch(sub, job, rationale, p.matchId)) {
        await markSent(p.matchId)
        allowance--
        summary.alertsSent++
      }
    }
  }
  if (allowance <= 0) return

  // 2. fresh matches
  const excludeIds = new Set(await matchedJobIds(sub.id, NO_RESEND_DAYS))
  // aggregators repost the same real job under different source rows — exclude by identity too
  const excludeKeys = await matchedDedupeKeys(sub.id, NO_RESEND_DAYS)
  const filtered = candidates.filter(
    (j) => !excludeIds.has(j.id) && !excludeKeys.has(j.dedupeKey) && tier1Filter(profile, j),
  )

  let embedding = sub.profileEmbedding
  if (!embedding) {
    embedding = await embedProfile(profile)
    if (embedding) await setEmbedding(sub.id, embedding)
  }

  const ranked: Array<{ job: JobLite; simScore: number }> = embedding
    ? tier2Rank(embedding, filtered, { threshold: TIER2_FLOOR, k: TIER2_TOP_K * 4 })
    : []

  if (ranked.length === 0) return

  // aggregators repost the same opening under slightly different locations and
  // dedupe keys (company+title+location) — collapse to one real job per
  // company+title so a day's top-5 isn't five variants of the same posting
  const seenRealJobs = new Set<string>()
  const uniqueRanked = ranked.filter(({ job }) => {
    const key = `${job.company.toLowerCase().trim()}::${normalizeTitle(job.title).slice(0, 40)}`
    if (seenRealJobs.has(key)) return false
    seenRealJobs.add(key)
    return true
  })

  // fetch full rows (description) only for the tier-3 survivors
  const fullJobs = await jobsByIds(uniqueRanked.slice(0, TIER2_TOP_K).map((r) => r.job.id))
  const fullById = new Map(fullJobs.map((j) => [j.id, j]))

  for (const cand of uniqueRanked.slice(0, TIER2_TOP_K)) {
    if (allowance <= 0) break
    const job = fullById.get(cand.job.id)
    if (!job) continue

    const review = await reviewFit(profile, job)
    if (review) {
      summary.reviewsRun++
    } else if (cand.simScore < sub.matchThreshold + FALLBACK_EXTRA_MARGIN) {
      // no LLM review available — tier-2 evidence alone must clear a higher bar
      continue
    }
    const effective = review ?? fallbackReview(cand.simScore, job)
    if (!effective.match) {
      // rejected reviews leave a trace — otherwise tuning the reviewer is blind
      logger.info('tier3_rejected', {
        jobId: job.id,
        company: job.company,
        title: job.title.slice(0, 50),
        fitScore: effective.fitScore,
        why: effective.whyThisFits[0]?.slice(0, 140),
        flag: effective.redFlags[0]?.slice(0, 140) ?? null,
      })
      continue
    }

    const matchId = await createMatch({
      subscriberId: sub.id,
      jobId: job.id,
      simScore: cand.simScore,
      fitScore: effective.fitScore,
      rationale: effective,
    })
    if (matchId === null) continue // already matched at some point

    // confirmed only after the channel accepts the delivery
    if (await notifier.deliverMatch(sub, job, effective, matchId)) {
      await markSent(matchId)
      allowance--
      summary.alertsSent++
    }
  }
}
