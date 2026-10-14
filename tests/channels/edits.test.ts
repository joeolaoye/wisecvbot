import { profileSchema } from '../../src/domain/job.js'
import { parseProfileEdits } from '../../src/channels/telegram.js'

const base = profileSchema.parse({
  roleFamily: 'backend',
  seniority: 'senior',
  skills: ['Python', 'Go', 'AWS', 'PHP'],
})

describe('parseProfileEdits', () => {
  test('multi-line edits with different fields', () => {
    const { profile, applied } = parseProfileEdits(
      base,
      'seniority: staff\nskills: +Rust -PHP\nremote: only\nsalary: 160k',
    )
    expect(profile.seniority).toBe('staff')
    expect(profile.skills).toContain('Rust')
    expect(profile.skills).not.toContain('PHP')
    expect(profile.remoteOnly).toBe(true)
    expect(profile.salaryFloor).toBe(160000)
    expect(applied).toHaveLength(4)
  })

  test('"|"-separated one-liners work too', () => {
    const { profile } = parseProfileEdits(base, 'role: devops | location: Berlin')
    expect(profile.roleFamily).toBe('devops')
    expect(profile.location).toBe('Berlin')
  })

  test('invalid values are ignored, not applied', () => {
    const { profile, ignored } = parseProfileEdits(base, 'seniority: wizard')
    expect(profile.seniority).toBe('senior')
    expect(ignored).toHaveLength(1)
  })

  test('skills can be replaced wholesale with a comma list', () => {
    const { profile } = parseProfileEdits(base, 'skills: Kotlin, Kubernetes')
    expect(profile.skills).toEqual(['Kotlin', 'Kubernetes'])
  })

  test('salary floor clears with "none"', () => {
    const picky = profileSchema.parse({ ...base, salaryFloor: 200000 })
    const { profile } = parseProfileEdits(picky, 'salary: none')
    expect(profile.salaryFloor).toBeNull()
  })
})
