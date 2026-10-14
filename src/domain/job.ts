import { z } from 'zod'

export const ROLE_FAMILIES = [
  'backend',
  'frontend',
  'fullstack',
  'mobile',
  'devops',
  'data',
  'ml',
  'security',
  'qa',
  'management',
  'other',
] as const
export type RoleFamily = (typeof ROLE_FAMILIES)[number]
export const roleFamilySchema = z.enum(ROLE_FAMILIES)

export const SENIORITIES = ['junior', 'mid', 'senior', 'lead', 'staff', 'principal', 'exec'] as const
export type Seniority = (typeof SENIORITIES)[number]
export const senioritySchema = z.enum(SENIORITIES)

/** A job straight from a source adapter, before normalization. */
export const rawJobSchema = z.object({
  /** e.g. "greenhouse:stripe" */
  source: z.string().min(1),
  externalId: z.string().min(1),
  company: z.string().min(1),
  title: z.string().min(1),
  /** Canonical URL from the ATS record — never from description text (architecture §8). */
  url: z.string().min(1),
  location: z.string().nullable().default(null),
  remoteHint: z.boolean().default(false),
  salaryText: z.string().nullable().default(null),
  descriptionText: z.string(),
})
export type RawJob = z.infer<typeof rawJobSchema>

/** Structured fields derived by the pipeline (rules first, LLM refines). */
export const jobStructuredSchema = z.object({
  roleFamily: roleFamilySchema,
  seniority: senioritySchema,
  skills: z.array(z.string()).max(15),
})
export type JobStructured = z.infer<typeof jobStructuredSchema>

/**
 * The subscriber profile — the ONLY thing matching ever reads (user-journey doc §6:
 * tiers read what the user ratified at the confirmation card, never raw extraction).
 */
export const profileSchema = z.object({
  roleFamily: roleFamilySchema,
  seniority: senioritySchema,
  skills: z.array(z.string()).max(20),
  domains: z.array(z.string()).max(6).default([]),
  yearsExperience: z.number().int().min(0).max(50).nullable().default(null),
  location: z.string().nullable().default(null),
  remoteOnly: z.boolean().default(false),
  /** Annual USD floor; null = open. */
  salaryFloor: z.number().int().min(0).nullable().default(null),
  /** Free-text context from edits and "wrong direction" feedback. */
  notes: z.string().max(500).nullable().default(null),
  /** Fields the CV parse wasn't sure about — surfaced as ⚠️ on the confirmation card. */
  uncertain: z.array(z.string()).default([]),
})
export type Profile = z.infer<typeof profileSchema>

/**
 * Tier-3 LLM fit review. Zod-validated; anything malformed is discarded, never
 * shown. NOTE: every field is required (no .default()) — OpenAI strict
 * structured-output rejects schemas whose properties are not all in `required`.
 */
export const matchReviewSchema = z.object({
  match: z.boolean(),
  fitScore: z.number().int().min(0).max(100),
  whyThisFits: z.array(z.string()).min(1).max(4),
  redFlags: z.array(z.string()).max(4),
  questions: z.array(z.string()).max(3),
})
export type MatchReview = z.infer<typeof matchReviewSchema>
