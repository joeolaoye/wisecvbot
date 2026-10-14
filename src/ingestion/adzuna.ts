import { rawJobSchema, type RawJob } from '../domain/job.js'
import { env } from '../config/env.js'
import { fetchJson } from './http.js'

interface AdzunaResult {
  id: string
  title: string
  company?: { display_name?: string }
  location?: { display_name?: string }
  salary_min?: number
  salary_max?: number
  redirect_url: string
  description?: string
}

interface AdzunaResponse {
  results: AdzunaResult[]
}

export function mapAdzuna(results: AdzunaResult[]): RawJob[] {
  return results.map((r) =>
    rawJobSchema.parse({
      source: 'adzuna',
      externalId: r.id,
      company: r.company?.display_name ?? 'Unknown',
      title: r.title,
      url: r.redirect_url,
      location: r.location?.display_name ?? null,
      salaryText:
        r.salary_min && r.salary_max
          ? `${Math.round(r.salary_min)} - ${Math.round(r.salary_max)}`
          : null,
      descriptionText: r.description ?? '',
    }),
  )
}

/** Aggregator fallback — skipped entirely (returns []) when keys aren't configured. */
export async function fetchAdzuna(): Promise<RawJob[]> {
  if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) return []
  const url = new URL('https://api.adzuna.com/v1/api/jobs/us/search/1')
  url.searchParams.set('app_id', env.ADZUNA_APP_ID)
  url.searchParams.set('app_key', env.ADZUNA_APP_KEY)
  url.searchParams.set('what', 'software engineer')
  url.searchParams.set('results_per_page', '50')
  const data = await fetchJson<AdzunaResponse>(url.toString())
  return mapAdzuna(data.results ?? [])
}
