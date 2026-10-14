import { and, count, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm'
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
  salaryCurrency: string
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

  // unchanged repost: only bump lastSeen — no full-row rewrite 24×/day
  if (existing && existing.contentHash === input.contentHash) {
    const [row] = await db
      .update(jobs)
      .set({ lastSeen: new Date() })
      .where(eq(jobs.id, existing.id))
      .returning()
    return { job: row ?? existing, isNew: false, changed: false }
  }

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
        salaryCurrency: values.salaryCurrency,
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
    changed: Boolean(existing),
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

/**
 * Slim candidate shape for the orchestrator — everything tier 1/2 and message
 * formatting need, WITHOUT descriptionText (fetched later only for the ≤5
 * tier-3 survivors) so the daily run never hauls the whole corpus of job
 * text into memory.
 */
export const jobLiteColumns = {
  id: jobs.id,
  company: jobs.company,
  title: jobs.title,
  url: jobs.url,
  location: jobs.location,
  remote: jobs.remote,
  salaryMin: jobs.salaryMin,
  salaryMax: jobs.salaryMax,
  salaryCurrency: jobs.salaryCurrency,
  roleFamily: jobs.roleFamily,
  seniority: jobs.seniority,
  dedupeKey: jobs.dedupeKey,
  embedding: jobs.embedding,
  lastSeen: jobs.lastSeen,
} as const

export type JobLite = {
  id: number
  company: string
  title: string
  url: string
  location: string | null
  remote: boolean
  salaryMin: number | null
  salaryMax: number | null
  salaryCurrency: string
  roleFamily: string
  seniority: string
  dedupeKey: string
  embedding: number[] | null
  lastSeen: Date
}

export async function jobsSince(since: Date): Promise<JobLite[]> {
  return db.select(jobLiteColumns).from(jobs).where(gte(jobs.lastSeen, since)).orderBy(desc(jobs.lastSeen))
}

/** Full rows (description included) for the few jobs that reach tier 3 / delivery. */
export async function jobsByIds(ids: number[]): Promise<Job[]> {
  if (ids.length === 0) return []
  return db.select().from(jobs).where(inArray(jobs.id, ids))
}

/** Backlog drain: jobs still lacking embeddings (ingest enrichment catches up over runs). */
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

/** Stale postings eventually go; embeddings alone are ~6KB/row. */
export async function pruneJobs(days: number): Promise<void> {
  await db.delete(jobs).where(lt(jobs.lastSeen, new Date(Date.now() - days * 86_400_000)))
}
