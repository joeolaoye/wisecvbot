import type { MatchReview } from '../domain/job.js'
import type { Job, Subscriber } from '../storage/schema.js'

/**
 * Channel-agnostic delivery contract. v1: Telegram implements it; v2: WhatsApp
 * implements the same interface (architecture §2.3) — the pipeline never knows
 * which channel a subscriber is on beyond the row itself.
 */
export interface Notifier {
  /** Returns true when the message actually went out. */
  deliverMatch(
    subscriber: Subscriber,
    job: Job,
    review: MatchReview,
    matchId: number,
  ): Promise<boolean>
}

export function formatSalary(job: Job): string | null {
  if (job.salaryMin === null || job.salaryMax === null) return null
  const k = (n: number) => `$${Math.round(n / 1000)}k`
  return `${k(job.salaryMin)}–${k(job.salaryMax)}${job.salaryCurrency !== 'USD' ? ` ${job.salaryCurrency}` : ''}`
}

/**
 * Plain text, deliberately. Job titles/descriptions are untrusted strings; any
 * parse_mode (Markdown/HTML) would let a posting inject formatting or links
 * into our messages. No parse_mode anywhere in this codebase.
 */
export function formatMatchMessage(job: Job, review: MatchReview): string {
  const lines = [
    `🤖 New match: ${job.title} @ ${job.company}${job.remote ? ' (remote)' : ''}`,
    formatSalary(job),
    '',
    'Why it fits:',
    ...review.whyThisFits.map((w) => `• ${w}`),
  ]
  if (review.redFlags.length > 0) {
    lines.push('', `Flags: ${review.redFlags.join(' · ')}`)
  }
  return lines.filter((l) => l !== null).join('\n')
}

/** The Stage-4 confirmation card (user-journey doc). */
export function formatProfileCard(profile: {
  roleFamily: string
  seniority: string
  skills: string[]
  domains: string[]
  yearsExperience: number | null
  location: string | null
  remoteOnly: boolean
  salaryFloor: number | null
  uncertain: string[]
}): string {
  const mark = (field: string, label: string) => (profile.uncertain.includes(field) ? `${label} ⚠️` : label)
  const lines = [
    "Here's what I found — this is what I'll match jobs against:",
    '',
    `💼 ${mark('roleFamily', `${profile.seniority} ${profile.roleFamily}`)}${
      profile.yearsExperience !== null ? ` (≈${profile.yearsExperience} yrs)` : ''
    }`,
    `🛠 ${profile.skills.join(' · ') || '—'}`,
    profile.domains.length > 0 ? `🏭 ${profile.domains.join(', ')}` : null,
    `📍 ${profile.location ?? 'anywhere'}${profile.remoteOnly ? ' · remote only' : ''}`,
    profile.salaryFloor !== null ? `💰 floor $${profile.salaryFloor.toLocaleString('en-US')}` : null,
    '',
    '⚠️ = double-check me. Correct anything wrong before confirming.',
  ]
  return lines.filter((l): l is string => l !== null).join('\n')
}
