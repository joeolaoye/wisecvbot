import { rawJobSchema, type RawJob } from '../domain/job.js'
import { htmlToText } from '../pipeline/html.js'
import { fetchJson } from './http.js'

interface RemotiveJob {
  id: number
  url: string
  title: string
  company_name: string
  candidate_required_location?: string
  salary?: string
  description?: string
}

interface RemotiveResponse {
  jobs: RemotiveJob[]
}

export function mapRemotive(jobs: RemotiveJob[]): RawJob[] {
  return jobs.map((j) =>
    rawJobSchema.parse({
      source: 'remotive',
      externalId: String(j.id),
      company: j.company_name,
      title: j.title,
      url: j.url,
      location: j.candidate_required_location ?? 'Remote',
      remoteHint: true,
      salaryText: j.salary ?? null,
      descriptionText: htmlToText(j.description ?? ''),
    }),
  )
}

export async function fetchRemotive(): Promise<RawJob[]> {
  const data = await fetchJson<RemotiveResponse>('https://remotive.com/api/remote-jobs?limit=100')
  return mapRemotive(data.jobs ?? [])
}
