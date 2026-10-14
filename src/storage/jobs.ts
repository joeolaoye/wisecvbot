import { and, count, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { db } from './db.js'
import { jobs, type Job } from './schema.js'
import type { JobStructured } from '../domain/job.js'

export interface UpsertJobInput {
  source: string
  externalId: string
  company: string
  title: string
  url: string
  location: string | null
  remote: boolean
  salaryMin: number | null
  salaryMax: number | null
  descriptionText: string
  dedupeKey: string
  contentHash: string
  structured: JobStructured
}

export interface UpsertResult {
  job: Job
  isNew: boolean
  changed: boolean
}

export async function upsertJob(input: UpsertJobInput): Promise<UpsertResult> {
  const [existing] = await db.select().from(jobs).where(eq(jobs.dedupeKey, input.dedupeKey)).limit(1)

  const { structured, ...rest } = input
  const values = {
    ...rest,
    roleFamily: structured.roleFamily,
    seniority: structured.seniority,
    skills: structured.skills,
  }
  const [row] = await db
    .insert(jobs)
    .values(values)
    .onConflictDoUpdate({
      target: jobs.dedupeKey,
      set: {
        title: values.title,
        url: values.url,
        location: values.location,
        remote: values.remote,
        salaryMin: values.salaryMin,
        salaryMax: values.salaryMax,
        descriptionText: values.descriptionText,
        contentHash: values.contentHash,
        lastSeen: new Date(),
      },
    })
    .returning()
  if (!row) throw new Error('upsertJob returned no row')

  return {
    job: row,
    isNew: !existing,
    changed: Boolean(existing && existing.contentHash !== input.contentHash),
  }
}

/** LLM refinement applied after the rules-based upsert — overwrites role/seniority/skills, sets embedding. */
export async function updateJobAi(
  jobId: number,
  patch: { embedding?: number[]; structured?: JobStructured },
): Promise<void> {
  const set: Record<string, unknown> = {}
  if (patch.embedding) set.embedding = patch.embedding
  if (patch.structured) {
    set.roleFamily = patch.structured.roleFamily
    set.seniority = patch.structured.seniority
    set.skills = patch.structured.skills
  }
  if (Object.keys(set).length === 0) return
  await db.update(jobs).set(set).where(eq(jobs.id, jobId))
}

export async function jobsSince(since: Date): Promise<Job[]> {
  return db.select().from(jobs).where(gte(jobs.lastSeen, since)).orderBy(desc(jobs.lastSeen))
}

export async function jobsMissingEmbedding(limit: number): Promise<Job[]> {
  return db
    .select()
    .from(jobs)
    .where(and(isNull(jobs.embedding), gte(jobs.lastSeen, new Date(Date.now() - 7 * 86_400_000))))
    .orderBy(desc(jobs.lastSeen))
    .limit(limit)
}

export async function countJobs(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(jobs)
  return Number(row?.value ?? 0)
}

function toVectorLiteral(embedding: number[]): string {
  return `'[${embedding.map((n) => Number(n).toFixed(6)).join(',')}]'::vector`
}

/** Distance-ordered candidate jobs for tier 2 (pgvector cosine, `<=>`). */
export async function nearestJobs(
  embedding: number[],
  candidateIds: number[],
  limit: number,
): Promise<{ job: Job; distance: number }[]> {
  if (candidateIds.length === 0) return []

  const out: { job: Job; distance: number }[] = []
  const vec = sql.raw(toVectorLiteral(embedding))
  const ids = [...candidateIds]

  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const rows = await db
      .select({ job: jobs, distance: sql<number>`${jobs.embedding} <=> ${vec}` })
      .from(jobs)
      .where(and(inArray(jobs.id, chunk), sql`${jobs.embedding} is not null`))
      .orderBy(sql`${jobs.embedding} <=> ${vec}`)
      .limit(limit)
    for (const r of rows) out.push({ job: r.job, distance: Number(r.distance) })
  }
  out.sort((a, b) => a.distance - b.distance)
  return out.slice(0, limit)
}
