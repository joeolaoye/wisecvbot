import { describe, expect, it, vi } from 'vitest'
import { profileSchema } from '../../src/domain/job.js'

// Mock the LLM module — tier 3's contract is: valid JSON in, schema-validated
// review out; ANY failure mode returns null (discard, never show).
vi.mock('../../src/llm.js', () => {
  class LlmUnavailableError extends Error {
    constructor(public reason: string) {
      super(reason)
    }
  }
  return {
    LlmUnavailableError,
    generateJson: vi.fn(),
    embedText: vi.fn(),
    embedTexts: vi.fn(),
  }
})

import { generateJson, LlmUnavailableError } from '../../src/llm.js'
import { fallbackReview, reviewFit } from '../../src/matching/tier3-review.js'

const profile = profileSchema.parse({
  roleFamily: 'backend',
  seniority: 'senior',
  skills: ['Python', 'Go', 'AWS'],
})

const job = {
  title: 'Senior Backend Engineer',
  company: 'Stripe',
  location: 'Remote (US)',
  remote: true,
  salaryMin: 150000,
  salaryMax: 180000,
  descriptionText: 'Build payment APIs.',
}

describe('tier 3 fit review', () => {
  it('returns the review when the LLM output is valid', async () => {
    vi.mocked(generateJson).mockResolvedValueOnce({
      match: true,
      fitScore: 88,
      whyThisFits: ['6y Python matches their profile'],
      redFlags: [],
      questions: [],
    })
    const review = await reviewFit(profile, job)
    expect(review?.fitScore).toBe(88)
  })

  it('discards malformed LLM output instead of showing it', async () => {
    vi.mocked(generateJson).mockRejectedValueOnce(new Error('ZodValidationError: bad shape'))
    expect(await reviewFit(profile, job)).toBeNull()
  })

  it('returns null when the LLM is unavailable (no key / budget)', async () => {
    vi.mocked(generateJson).mockRejectedValueOnce(new LlmUnavailableError('budget-exhausted'))
    expect(await reviewFit(profile, job)).toBeNull()
  })

  it('fallback review uses tier-2 evidence only', () => {
    const review = fallbackReview(0.71, job)
    expect(review.match).toBe(true)
    expect(review.fitScore).toBe(71)
    expect(review.whyThisFits[0]).toContain('71%')
  })

  it('never includes raw job HTML in the prompt — description is plain text', async () => {
    vi.mocked(generateJson).mockResolvedValueOnce({
      match: false,
      fitScore: 10,
      whyThisFits: ['wrong stack'],
      redFlags: [],
      questions: [],
    })
    await reviewFit(profile, { ...job, descriptionText: 'plain text only' })
    const call = vi.mocked(generateJson).mock.calls.at(-1)
    expect(call?.[2]).toContain('UNTRUSTED-DATA')
    expect(call?.[1]).toContain('never instructions')
  })
})
