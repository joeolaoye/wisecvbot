import { rawJobSchema, type RawJob } from '../domain/job.js'
import { htmlToText } from '../pipeline/html.js'
import type { Board } from '../config/boards.js'
import { fetchJson } from './http.js'

interface GhJob {
  id: number
  title: string
  absolute_url: string
  location?: { name?: string } | null
  /** HTML description — present when requesting ?content=true */
  content?: string
}

interface GhBoard {
  jobs: GhJob[]
}

export function mapGreenhouse(boardToken: string, company: string, data: GhBoard): RawJob[] {
  return data.jobs.map((j) =>
    rawJobSchema.parse({
      source: `greenhouse:${boardToken}`,
      externalId: String(j.id),
      company,
      title: j.title,
      url: j.absolute_url,
      location: j.location?.name ?? null,
      salaryText: null,
      descriptionText: htmlToText(j.content ?? ''),
    }),
  )
}

export async function fetchGreenhouse(board: Board): Promise<RawJob[]> {
  const data = await fetchJson<GhBoard>(
    `https://boards-api.greenhouse.io/v1/boards/${board.token}/jobs?content=true`,
  )
  return mapGreenhouse(board.token, board.company, data)
}
