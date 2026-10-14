import { profileSchema } from '../../src/domain/job.js'
import { tier1Filter } from '../../src/matching/tier1-filters.js'
import { cosineSimilarity, tier2Rank } from '../../src/matching/tier2-embeddings.js'

const profile = profileSchema.parse({
  roleFamily: 'backend',
  seniority: 'senior',
  skills: ['Python', 'Go', 'AWS'],
})

const job = (over: Partial<Parameters<typeof tier1Filter>[1]> = {}) => ({
  roleFamily: 'backend',
  seniority: 'senior',
  remote: false,
  salaryMin: null,
  salaryMax: null,
  ...over,
})

describe('tier 1 filters', () => {
  test('matching family, level, and no constraints passes', () => {
    expect(tier1Filter(profile, job())).toBe(true)
  })

  test('family must match or be a neighbor', () => {
    expect(tier1Filter(profile, job({ roleFamily: 'frontend' }))).toBe(false)
    expect(tier1Filter(profile, job({ roleFamily: 'fullstack' }))).toBe(true)
    expect(tier1Filter(profile, job({ roleFamily: 'other' }))).toBe(true)
  })

  test('seniority window is ±1 level (ladder: junior mid senior lead staff principal exec)', () => {
    expect(tier1Filter(profile, job({ seniority: 'mid' }))).toBe(true)
    expect(tier1Filter(profile, job({ seniority: 'lead' }))).toBe(true)
    expect(tier1Filter(profile, job({ seniority: 'junior' }))).toBe(false)
    expect(tier1Filter(profile, job({ seniority: 'staff' }))).toBe(false)
    expect(tier1Filter(profile, job({ seniority: 'exec' }))).toBe(false)
  })

  test('salary floor only excludes when the job salary is known', () => {
    const picky = profileSchema.parse({ ...profile, salaryFloor: 150000 })
    expect(tier1Filter(picky, job({ salaryMax: 160000 }))).toBe(true)
    expect(tier1Filter(picky, job({ salaryMax: 120000 }))).toBe(false)
    expect(tier1Filter(picky, job())).toBe(true) // unknown salary never excludes
  })

  test('non-USD salaries skip the floor check — no cross-currency comparisons', () => {
    const picky = profileSchema.parse({ ...profile, salaryFloor: 150000 })
    expect(tier1Filter(picky, job({ salaryMax: 120000, salaryCurrency: 'EUR' }))).toBe(true)
  })

  test('remote-only profiles skip on-site jobs', () => {
    const remoteOnly = profileSchema.parse({ ...profile, remoteOnly: true })
    expect(tier1Filter(remoteOnly, job({ remote: false }))).toBe(false)
    expect(tier1Filter(remoteOnly, job({ remote: true }))).toBe(true)
  })
})

describe('tier 2 embeddings', () => {
  test('cosine similarity: identical 1, orthogonal 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 2], [2, 4])).toBeCloseTo(1)
  })

  test('rank filters by threshold and orders by similarity', () => {
    const target = [1, 0]
    const jobs = [
      { id: 1, embedding: [1, 0] },
      { id: 2, embedding: [0.9, 0.1] },
      { id: 3, embedding: [0, 1] },
      { id: 4, embedding: null },
    ]
    const ranked = tier2Rank(target, jobs, { threshold: 0.5, k: 2 })
    expect(ranked.map((r) => r.job.id)).toEqual([1, 2])
    expect(ranked[0]!.simScore).toBeGreaterThan(ranked[1]!.simScore)
  })
})
