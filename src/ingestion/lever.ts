import { rawJobSchema, type RawJob } from '../domain/job.js'
import { htmlToText } from '../pipeline/html.js'
import type { Board } from '../config/boards.js'
import { fetchJson } from './http.js'

interface LeverPosting {
  id: string
  /** In Lever's API, `text` is the job title. */
  text: string
  hostedUrl: string
  categories?: { location?: string; commitment?: string; team?: string }
  descriptionPlain?: string
  descriptionHtml?: string
}

export function mapLever(boardToken: string, company: string, postings: LeverPosting[]): RawJob[] {
  return postings.map((p) =>
    rawJobSchema.parse({
      source: `lever:${boardToken}`,
      externalId: p.id,
      company,
      title: p.text,
      url: p.hostedUrl,
      location: p.categories?.location ?? null,
      salaryText: null,
      descriptionText: p.descriptionPlain ?? htmlToText(p.descriptionHtml ?? ''),
    }),
  )
}

export async function fetchLever(board: Board): Promise<RawJob[]> {
  const data = await fetchJson<LeverPosting[]>(
    `https://api.lever.co/v0/postings/${board.token}?mode=json`,
  )
  return mapLever(board.token, board.company, data)
}
