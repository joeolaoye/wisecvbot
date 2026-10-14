import { readFileSync } from 'node:fs'
import { testDir } from '../helpers.js'
import { mapGreenhouse } from '../../src/ingestion/greenhouse.js'
import { mapLever } from '../../src/ingestion/lever.js'
import { mapAshby } from '../../src/ingestion/ashby.js'
import { mapRemotive } from '../../src/ingestion/remotive.js'
import { buildUpsertInput } from '../../src/ingestion/index.js'

const fixture = (name: string) => JSON.parse(readFileSync(`${testDir}/fixtures/${name}`, 'utf8'))

describe('source adapters (recorded fixtures, no network)', () => {
  test('greenhouse: maps fields, strips HTML, keeps canonical URL', () => {
    const jobs = mapGreenhouse('stripe', 'Stripe', fixture('greenhouse.json'))
    expect(jobs).toHaveLength(2)
    const senior = jobs[0]!
    expect(senior.title).toBe('Senior Backend Engineer')
    expect(senior.url).toBe('https://boards.greenhouse.io/stripe/jobs/123456')
    expect(senior.location).toBe('Remote (US)')
    expect(senior.descriptionText).toContain('Build payment APIs with Python and Go.')
    expect(senior.descriptionText).not.toContain('<')
  })

  test('lever: `text` is the title; prefers plain description, falls back to HTML', () => {
    const jobs = mapLever('vercel', 'Vercel', fixture('lever.json'))
    expect(jobs[0]!.title).toBe('Full-Stack Engineer')
    expect(jobs[0]!.descriptionText).toContain('Next.js')
    expect(jobs[1]!.title).toBe('Engineering Manager, Platform')
    expect(jobs[1]!.descriptionText).toContain('Lead the platform team.')
  })

  test('ashby: isRemote sets the remote hint', () => {
    const jobs = mapAshby('linear', 'Linear', fixture('ashby.json'))
    expect(jobs[0]!.remoteHint).toBe(true)
    expect(jobs[1]!.remoteHint).toBe(false)
    expect(jobs[1]!.descriptionText).toContain('Design interfaces for technical products.')
  })

  test('remotive: salary text passes through for the normalizer', () => {
    const jobs = mapRemotive(fixture('remotive.json').jobs)
    expect(jobs[0]!.salaryText).toBe('$120k - $150k')
    expect(jobs[0]!.company).toBe('Acme Cloud')
    expect(jobs[0]!.remoteHint).toBe(true)
  })

  test('buildUpsertInput: salary parsed with currency, remote detected, rules classification applied', () => {
    const input = buildUpsertInput(mapRemotive(fixture('remotive.json').jobs)[0]!)
    expect(input.salaryMin).toBe(120000)
    expect(input.salaryMax).toBe(150000)
    expect(input.salaryCurrency).toBe('USD')
    expect(input.remote).toBe(true)
    expect(input.structured.roleFamily).toBe('devops')
    expect(input.structured.seniority).toBe('mid')
    expect(input.dedupeKey).toBe('acme cloud::devops engineer::anywhere')
    expect(input.contentHash).toHaveLength(64)
  })
})
