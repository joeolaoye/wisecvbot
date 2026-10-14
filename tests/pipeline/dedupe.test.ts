import { contentHashFor, dedupeKeyFor, normalizeTitle } from '../../src/pipeline/dedupe.js'

const base = {
  company: 'Stripe',
  title: 'Senior Backend Engineer',
  location: 'Remote (US)',
  descriptionText: 'Build payment APIs.',
}

describe('dedupe', () => {
  test('normalizeTitle collapses case and punctuation', () => {
    expect(normalizeTitle('  Senior   BACK-END/engineer! ')).toBe('senior back end engineer')
  })

  test('same job identity across reposts → same dedupe key', () => {
    expect(dedupeKeyFor(base)).toBe(
      dedupeKeyFor({ company: 'stripe', title: 'senior backend engineer', location: 'remote (us)' }),
    )
  })

  test('different location is a different job', () => {
    expect(dedupeKeyFor(base)).not.toBe(dedupeKeyFor({ ...base, location: 'Seattle, WA' }))
  })

  test('content edits change the hash, not the identity', () => {
    const edited = { ...base, descriptionText: 'Build payment APIs. NEW salary band.' }
    expect(dedupeKeyFor(edited)).toBe(dedupeKeyFor(base))
    expect(contentHashFor(edited)).not.toBe(contentHashFor(base))
  })

  test('hash is stable', () => {
    expect(contentHashFor(base)).toBe(contentHashFor({ ...base }))
  })
})
