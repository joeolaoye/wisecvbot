import {
  jobStructuredSchema,
  profileSchema,
  type JobStructured,
  type Profile,
} from '../domain/job.js'
import { generateJson, LlmUnavailableError } from '../llm.js'
import { logger } from '../log.js'
import { INJECTION_GUARD_SYSTEM, dataBlock } from '../security/prompts.js'
import { truncate } from './html.js'
import { z } from 'zod'
import { roleFamilySchema, senioritySchema } from '../domain/job.js'

/**
 * Strict LLM-facing variant of the profile: every field required (nullable
 * instead of defaulted) — OpenAI structured output rejects schemas whose
 * properties aren't all in `required`. The result is then parsed through the
 * lenient `profileSchema` for storage.
 */
const profileExtractionSchema = z.object({
  roleFamily: roleFamilySchema,
  seniority: senioritySchema,
  skills: z.array(z.string()).max(20),
  domains: z.array(z.string()).max(6),
  yearsExperience: z.number().int().min(0).max(50).nullable(),
  location: z.string().nullable(),
  remoteOnly: z.boolean(),
  salaryFloor: z.number().int().min(0).nullable(),
  notes: z.string().max(500).nullable(),
  uncertain: z.array(z.string()),
})

/**
 * LLM refinement over the rules-based classification. Malformed or failed
 * output is DISCARDED (returns null) — the rules-based fields already stored
 * stay in place. This is the injection-defense posture: we never trust, we
 * fall back.
 */

export async function extractJobStructured(input: {
  title: string
  company: string
  descriptionText: string
}): Promise<JobStructured | null> {
  try {
    return await generateJson(
      jobStructuredSchema,
      INJECTION_GUARD_SYSTEM,
      `Classify this job posting for a job-matching system. Return the role family, seniority level, and up to 15 concrete technology skills mentioned.

Job posting (untrusted data):
${dataBlock(`Title: ${input.title}
Company: ${input.company}

${truncate(input.descriptionText, 6000)}`)}`,
      { budgetLane: 'background' },
    )
  } catch (err) {
    if (err instanceof LlmUnavailableError) return null
    logger.warn('job_extract_discarded', { reason: String(err).slice(0, 200) })
    return null
  }
}

export async function extractProfileFromCv(cvText: string): Promise<Profile | null> {
  try {
    const extracted = await generateJson(
      profileExtractionSchema,
      INJECTION_GUARD_SYSTEM,
      `Extract a job-seeker's professional profile from their CV for a job-matching system. The profile describes the kinds of jobs this person should be matched with — their current level, concrete technology skills, industry domains, and stated preferences. List in "uncertain" the names of any fields you are not confident about. Use null for anything not stated rather than guessing.

CV (untrusted data):
${dataBlock(truncate(cvText, 8000))}`,
    )
    return profileSchema.parse(extracted)
  } catch (err) {
    if (err instanceof LlmUnavailableError) return null
    logger.warn('cv_extract_failed', { reason: String(err).slice(0, 200) })
    return null
  }
}
