import { and, count, eq, gte, lt, sql } from 'drizzle-orm'
import { db } from './db.js'
import { deadLetters, events, jobs, llmSpend, matches, type MatchStatus } from './schema.js'
import type { MatchReview } from '../domain/job.js'

// ── matches ──────────────────────────────────────────────────────────

/** Returns the match id, or null when this subscriber already got this job. */
export async function createMatch(input: {
  subscriberId: number
  jobId: number
  simScore: number
  fitScore: number
  rationale: MatchReview
}): Promise<number | null> {
  const rows = await db
    .insert(matches)
    .values({ ...input, status: 'pending', sentAt: new Date(0) })
    .onConflictDoNothing({ target: [matches.subscriberId, matches.jobId] })
    .returning({ id: matches.id })
  return rows[0]?.id ?? null
}

/** Confirm delivery — the row only counts once the channel accepted it. */
export async function markSent(matchId: number): Promise<void> {
  await db
    .update(matches)
    .set({ status: 'sent', sentAt: new Date() })
    .where(eq(matches.id, matchId))
}

export async function countSentToday(subscriberId: number): Promise<number> {
  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)
  const rows = await db
    .select({ id: matches.id })
    .from(matches)
    .where(
      and(
        eq(matches.subscriberId, subscriberId),
        eq(matches.status, 'sent'),
        gte(matches.sentAt, dayStart),
      ),
    )
  return rows.length
}

/**
 * Jobs already delivered to this subscriber in the window — excluded from new
 * candidate sets. Returns ids AND dedupe keys so aggregator reposts of the
 * same real job (slightly different source rows) are also excluded.
 */
export async function matchedJobIds(subscriberId: number, days: number): Promise<number[]> {
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await db
    .select({ jobId: matches.jobId })
    .from(matches)
    .where(and(eq(matches.subscriberId, subscriberId), eq(matches.status, 'sent'), gte(matches.sentAt, since)))
  return rows.map((r) => r.jobId)
}

export async function matchedDedupeKeys(subscriberId: number, days: number): Promise<Set<string>> {
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await db
    .select({ dedupeKey: jobs.dedupeKey })
    .from(matches)
    .innerJoin(jobs, eq(matches.jobId, jobs.id))
    .where(and(eq(matches.subscriberId, subscriberId), eq(matches.status, 'sent'), gte(matches.sentAt, since)))
  return new Set(rows.map((r) => r.dedupeKey))
}

/** Undelivered rows from an interrupted run — retried first on the next run. */
export async function pendingMatches(
  subscriberId: number,
): Promise<Array<{ matchId: number; jobId: number; rationale: MatchReview | null }>> {
  const rows = await db
    .select({ matchId: matches.id, jobId: matches.jobId, rationale: matches.rationale })
    .from(matches)
    .where(and(eq(matches.subscriberId, subscriberId), eq(matches.status, 'pending')))
  return rows
}

export async function markFeedback(
  matchId: number,
  status: MatchStatus,
  feedback?: string,
): Promise<void> {
  await db
    .update(matches)
    .set({ status, feedback: feedback ?? null })
    .where(eq(matches.id, matchId))
}

export async function getMatch(matchId: number) {
  const [row] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
  return row ?? null
}

// ── events / dead letters / spend ────────────────────────────────────

export async function logEvent(
  subscriberId: number | null,
  type: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({ subscriberId, type, payload: payload ?? {} })
}

export async function recordDeadLetter(
  source: string,
  error: string,
  payloadSample?: string,
): Promise<void> {
  await db.insert(deadLetters).values({ source, error, payloadSample: payloadSample?.slice(0, 500) })
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function spendCentsToday(): Promise<number> {
  const [row] = await db.select().from(llmSpend).where(eq(llmSpend.day, utcDay())).limit(1)
  return row?.cents ?? 0
}

export async function addSpend(cents: number): Promise<void> {
  await db
    .insert(llmSpend)
    .values({ day: utcDay(), cents })
    .onConflictDoUpdate({
      target: llmSpend.day,
      set: { cents: sql`${llmSpend.cents} + ${cents}` },
    })
}

/** Retention: keep events/dead_letters bounded; callers wrap in weekly crons. */
export async function pruneEvents(days: number): Promise<void> {
  const cutoff = new Date(Date.now() - days * 86_400_000)
  await db.delete(events).where(lt(events.createdAt, cutoff))
  await db.delete(deadLetters).where(lt(deadLetters.createdAt, cutoff))
}

export async function deadLetterCount(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(deadLetters)
  return Number(row?.value ?? 0)
}
