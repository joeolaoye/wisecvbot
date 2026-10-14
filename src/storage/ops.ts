import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from './db.js'
import { deadLetters, events, llmSpend, matches, type MatchStatus } from './schema.js'
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
    .values(input)
    .onConflictDoNothing({ target: [matches.subscriberId, matches.jobId] })
    .returning({ id: matches.id })
  return rows[0]?.id ?? null
}

export async function countSentToday(subscriberId: number): Promise<number> {
  const dayStart = new Date()
  dayStart.setUTCHours(0, 0, 0, 0)
  const rows = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.subscriberId, subscriberId), gte(matches.sentAt, dayStart)))
  return rows.length
}

/** Jobs already sent to this subscriber in the window — excluded from new candidate sets. */
export async function matchedJobIds(subscriberId: number, days: number): Promise<number[]> {
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = await db
    .select({ jobId: matches.jobId })
    .from(matches)
    .where(and(eq(matches.subscriberId, subscriberId), gte(matches.sentAt, since)))
  return rows.map((r) => r.jobId)
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
