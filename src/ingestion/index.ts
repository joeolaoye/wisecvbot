import { defaultBoardsPath, loadBoardsFromFile, type AtsName, type Board } from '../config/boards.js'
import { env } from '../config/env.js'
import type { RawJob } from '../domain/job.js'
import { logger } from '../log.js'
import { extractJobStructured } from '../pipeline/extract.js'
import { embedJob } from '../pipeline/embed.js'
import { contentHashFor, dedupeKeyFor } from '../pipeline/dedupe.js'
import { classifyRoleFamily, classifySeniority, detectRemote, parseSalary } from '../pipeline/normalize.js'
import { jobsMissingEmbedding, upsertJob, updateJobAi, type UpsertJobInput } from '../storage/jobs.js'
import { logEvent, recordDeadLetter } from '../storage/ops.js'
import { fetchAshby } from './ashby.js'
import { fetchAdzuna } from './adzuna.js'
import { fetchGreenhouse } from './greenhouse.js'
import { fetchLever } from './lever.js'
import { fetchRemotive } from './remotive.js'

const ADAPTERS: Record<AtsName, (board: Board) => Promise<RawJob[]>> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
}

/** Rules-based normalization → the exact shape storage expects. */
export function buildUpsertInput(raw: RawJob): UpsertJobInput {
  const salary = parseSalary(raw.salaryText)
  return {
    source: raw.source,
    externalId: raw.externalId,
    company: raw.company,
    title: raw.title,
    url: raw.url,
    location: raw.location,
    remote: raw.remoteHint || detectRemote(raw.location, raw.title),
    salaryMin: salary?.min ?? null,
    salaryMax: salary?.max ?? null,
    salaryCurrency: salary?.currency ?? 'USD',
    descriptionText: raw.descriptionText,
    dedupeKey: dedupeKeyFor(raw),
    contentHash: contentHashFor(raw),
    structured: {
      roleFamily: classifyRoleFamily(raw.title),
      seniority: classifySeniority(raw.title),
      skills: [],
    },
  }
}

export interface IngestSummary {
  sourcesOk: number
  sourcesFailed: number
  jobsSeen: number
  jobsNew: number
  jobsChanged: number
  enriched: number
}

export async function runIngestion(
  opts: { boards?: Board[]; maxEnrich?: number } = {},
): Promise<IngestSummary> {
  const boards = opts.boards ?? loadBoardsFromFile(defaultBoardsPath())
  const sources: Array<{ name: string; run: () => Promise<RawJob[]> }> = [
    ...boards.map((b) => ({ name: `${b.ats}:${b.token}`, run: () => ADAPTERS[b.ats](b) })),
    { name: 'remotive', run: () => fetchRemotive() },
    { name: 'adzuna', run: () => fetchAdzuna() },
  ]

  const settled = await Promise.allSettled(sources.map((s) => s.run()))
  const summary: IngestSummary = {
    sourcesOk: 0,
    sourcesFailed: 0,
    jobsSeen: 0,
    jobsNew: 0,
    jobsChanged: 0,
    enriched: 0,
  }

  for (const [i, result] of settled.entries()) {
    const source = sources[i]!
    if (result.status === 'rejected') {
      summary.sourcesFailed++
      // a dead board never crashes the run (architecture §2.1)
      await recordDeadLetter(source.name, String(result.reason).slice(0, 300))
      logger.warn('ingest_source_failed', { source: source.name, error: String(result.reason).slice(0, 200) })
      continue
    }
    summary.sourcesOk++
    summary.jobsSeen += result.value.length

    for (const raw of result.value) {
      const upserted = await upsertJob(buildUpsertInput(raw))
      if (upserted.isNew) summary.jobsNew++
      if (upserted.changed) summary.jobsChanged++
    }
  }

  // LLM enrichment drains a BACKLOG (jobs still missing embeddings), not just
  // this run's new rows — the first ingest of 40 boards yields thousands of
  // jobs and catches up across runs (MAX_ENRICH_PER_RUN controls the pace).
  // Degrades to rules-only when no key or budget is exhausted.
  const cap = opts.maxEnrich ?? env.MAX_ENRICH_PER_RUN
  let enriched = 0
  while (enriched < cap) {
    const batch = await jobsMissingEmbedding(Math.min(10, cap - enriched))
    if (batch.length === 0) break
    for (const job of batch) {
      const structured = await extractJobStructured({
        title: job.title,
        company: job.company,
        descriptionText: job.descriptionText,
      })
      const embedding = await embedJob(job)
      if (structured || embedding) {
        await updateJobAi(job.id, {
          structured: structured ?? undefined,
          embedding: embedding ?? undefined,
        })
        enriched++
      } else {
        // LLM unavailable — stop draining this run rather than looping
        return finish(summary, enriched)
      }
    }
  }
  return finish(summary, enriched)
}

function finish(summary: IngestSummary, enriched: number): Promise<IngestSummary> {
  summary.enriched = enriched
  // awaited: the CLI closes the DB pool right after runIngestion returns —
  // a fire-and-forget insert here dies with the pool
  return logEvent(null, 'ingest_run', { ...summary }).then(() => {
    logger.info('ingest_run', { ...summary })
    return summary
  })
}
