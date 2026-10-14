import type { Profile, RoleFamily, Seniority } from '../domain/job.js'

/**
 * Tier 1 — free SQL-style filters. Kills ~80–90% of jobs before anything
 * expensive looks at them (architecture §5).
 */

const LADDER: Seniority[] = ['junior', 'mid', 'senior', 'lead', 'staff', 'principal', 'exec']

/** Adjacent role families count as matches — a backend profile sees fullstack roles. */
const FAMILY_NEIGHBORS: Partial<Record<RoleFamily, RoleFamily[]>> = {
  fullstack: ['backend', 'frontend'],
  backend: ['fullstack'],
  frontend: ['fullstack'],
}

export function seniorityWithin(profileSeniority: Seniority, jobSeniority: Seniority, window = 1): boolean {
  const p = LADDER.indexOf(profileSeniority)
  const j = LADDER.indexOf(jobSeniority)
  if (p < 0 || j < 0) return true // unknown levels never exclude a job
  return Math.abs(p - j) <= window
}

export interface Tier1Job {
  roleFamily: string
  seniority: string
  remote: boolean
  salaryMin: number | null
  salaryMax: number | null
}

export function tier1Filter(profile: Profile, job: Tier1Job): boolean {
  const neighbors = FAMILY_NEIGHBORS[profile.roleFamily] ?? []
  const familyOk =
    job.roleFamily === profile.roleFamily ||
    job.roleFamily === 'other' ||
    neighbors.includes(job.roleFamily as RoleFamily)
  if (!familyOk) return false

  if (!seniorityWithin(profile.seniority, job.seniority as Seniority)) return false

  if (profile.remoteOnly && !job.remote) return false

  // unknown job salary never excludes; known salary below the floor does
  if (profile.salaryFloor !== null && job.salaryMax !== null && job.salaryMax < profile.salaryFloor) {
    return false
  }

  return true
}
