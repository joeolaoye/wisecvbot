import { createHash } from 'node:crypto'
import type { RawJob } from '../domain/job.js'

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Stable identity: same company + title + location ⇒ same job across reposts. */
export function dedupeKeyFor(raw: Pick<RawJob, 'company' | 'title' | 'location'>): string {
  const company = raw.company.toLowerCase().trim()
  const location = (raw.location ?? 'na').toLowerCase().trim()
  return `${company}::${normalizeTitle(raw.title)}::${location}`
}

/** Changes when the posting content actually changes (salary edit, new description…). */
export function contentHashFor(raw: Pick<RawJob, 'company' | 'title' | 'location' | 'descriptionText'>): string {
  const descriptionHash = createHash('sha256').update(raw.descriptionText).digest('hex').slice(0, 32)
  return createHash('sha256').update(`${dedupeKeyFor(raw)}|${descriptionHash}`).digest('hex')
}
