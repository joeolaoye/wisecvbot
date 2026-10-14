import { defaultBoardsPath, loadBoardsFromFile, type AtsName, type Board } from '../config/boards.js'
import type { RawJob } from '../domain/job.js'
import { logger } from '../log.js'
import { extractJobStructured } from '../pipeline/extract.js'
import { embedJob } from '../pipeline/embed.js'
import { contentHashFor, dedupeKeyFor } from '../pipeline/dedupe.js'
import { classifyRoleFamily, classifySeniority, detectRemote, parseSalary } from '../pipeline/normalize.js'
import { upsertJob, updateJobAi, type UpsertJobInput } from '../storage/jobs.js'
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
  const toEnrich: Array<{ jobId: number; raw: RawJob }> = []

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
      if (upserted.isNew || upserted.changed) {
        summary.jobsChanged += upserted.changed ? 1 : 0
        toEnrich.push({ jobId: upserted.job.id, raw })
      }
    }
  }

  // LLM enrichment only for new/changed postings, capped per run; degrades to
  // rules-only classification when no key or budget is exhausted.
  const cap = opts.maxEnrich ?? 40
  for (const item of toEnrich.slice(0, cap)) {
    const structured = await extractJobStructured({
      title: item.raw.title,
      company: item.raw.company,
      descriptionText: item.raw.descriptionText,
    })
    const embedding = await embedJob({
      title: item.raw.title,
      company: item.raw.company,
      descriptionText: item.raw.descriptionText,
    })
    if (structured || embedding) {
      await updateJobAi(item.jobId, {
        structured: structured ?? undefined,
        embedding: embedding ?? undefined,
      })
      summary.enriched++
    }
  }

  await logEvent(null, 'ingest_run', { ...summary })
  logger.info('ingest_run', { ...summary })
  return summary
}
