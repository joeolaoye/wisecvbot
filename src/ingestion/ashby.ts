import { rawJobSchema, type RawJob } from '../domain/job.js'
import { htmlToText } from '../pipeline/html.js'
import type { Board } from '../config/boards.js'
import { fetchJson } from './http.js'

interface AshbyJob {
  id: string
  title: string
  jobUrl?: string
  location?: string
  isRemote?: boolean
  description?: string
  descriptionPlain?: string
}

interface AshbyBoard {
  jobs: AshbyJob[]
}

export function mapAshby(boardToken: string, company: string, data: AshbyBoard): RawJob[] {
  return data.jobs.map((j) =>
    rawJobSchema.parse({
      source: `ashby:${boardToken}`,
      externalId: j.id,
      company,
      title: j.title,
      url: j.jobUrl ?? `https://jobs.ashbyhq.com/${boardToken}/${j.id}`,
      location: j.location ?? null,
      remoteHint: j.isRemote ?? false,
      salaryText: null,
      descriptionText: j.descriptionPlain ?? htmlToText(j.description ?? ''),
    }),
  )
}

export async function fetchAshby(board: Board): Promise<RawJob[]> {
  const data = await fetchJson<AshbyBoard>(
    `https://api.ashbyhq.com/posting-api/job-board/${board.token}`,
  )
  return mapAshby(board.token, board.company, data)
}
