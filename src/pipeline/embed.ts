import type { Profile } from '../domain/job.js'
import { embedText, LlmUnavailableError } from '../llm.js'
import { truncate } from './html.js'

/** The subset of a stored job the embedder needs (kept decoupled from storage). */
export interface EmbeddableJob {
  title: string
  company: string
  descriptionText: string
}

export function jobEmbeddingText(job: EmbeddableJob): string {
  return `${job.title} at ${job.company}. ${truncate(job.descriptionText, 4000)}`
}

export function profileEmbeddingText(profile: Profile): string {
  const parts = [
    `${profile.seniority} ${profile.roleFamily} engineer`,
    `Skills: ${profile.skills.join(', ')}`,
    profile.domains.length > 0 ? `Domains: ${profile.domains.join(', ')}` : null,
    profile.yearsExperience !== null ? `${profile.yearsExperience} years experience` : null,
    profile.location ? `Based in ${profile.location}` : null,
    profile.remoteOnly ? 'Remote only' : 'Open to on-site/hybrid',
  ].filter((p): p is string => p !== null)
  return parts.join('. ')
}

export async function embedJob(job: EmbeddableJob): Promise<number[] | null> {
  try {
    return await embedText(jobEmbeddingText(job), { budgetLane: 'background' })
  } catch (err) {
    if (err instanceof LlmUnavailableError) return null
    throw err
  }
}

export async function embedProfile(profile: Profile): Promise<number[] | null> {
  try {
    return await embedText(profileEmbeddingText(profile))
  } catch (err) {
    if (err instanceof LlmUnavailableError) return null
    throw err
  }
}
