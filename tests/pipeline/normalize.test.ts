import { classifyRoleFamily, classifySeniority, detectRemote, parseSalary } from '../../src/pipeline/normalize.js'

describe('parseSalary', () => {
  test.each([
    ['$150,000 - $180,000', 150000, 180000, 'USD'],
    ['$150k–$175k', 150000, 175000, 'USD'],
    ['€60k-€80k per annum', 60000, 80000, 'EUR'],
    ['£90,000 to £110,000', 90000, 110000, 'GBP'],
    ['160k+', 160000, 160000, 'USD'],
    ['$135,000', 135000, 135000, 'USD'],
  ])('%s → %d..%d %s', (text, min, max, currency) => {
    expect(parseSalary(text)).toEqual({ min, max, currency })
  })

  test.each(['$50 - $70/hr', 'Competitive', null, '', 'Remote'])('%s → null (never guess)', (text) => {
    expect(parseSalary(text)).toBeNull()
  })

  test('years and other numbers are not salaries', () => {
    expect(parseSalary('Since 2020 we have grown to 500 people')).toBeNull()
  })
})

describe('detectRemote', () => {
  test('location signals', () => {
    expect(detectRemote('Remote (US)', 'Engineer')).toBe(true)
    expect(detectRemote('New York, NY', 'Engineer')).toBe(false)
  })
  test('title signals', () => {
    expect(detectRemote(null, 'Remote Developer Advocate')).toBe(true)
  })
})

describe('classifyRoleFamily', () => {
  test.each([
    ['Senior Backend Engineer', 'backend'],
    ['ML Engineer', 'ml'],
    ['Data Engineer', 'data'],
    ['Engineering Manager, Platform', 'management'],
    ['iOS Developer', 'mobile'],
    ['SRE', 'devops'],
    ['Frontend Engineer, Growth', 'frontend'],
    ['Full-Stack Engineer', 'fullstack'],
    ['Staff Software Engineer', 'backend'],
    ['Product Designer', 'other'],
  ])('%s → %s', (title, family) => {
    expect(classifyRoleFamily(title)).toBe(family)
  })
})

describe('classifySeniority', () => {
  test.each([
    ['Senior Backend Engineer', 'senior'],
    ['Staff Engineer', 'staff'],
    ['Principal Engineer', 'principal'],
    ['Lead Engineer', 'lead'],
    ['Junior Developer', 'junior'],
    ['VP of Engineering', 'exec'],
    ['Software Engineer', 'mid'],
    ['Software Engineer II', 'mid'],
  ])('%s → %s', (title, seniority) => {
    expect(classifySeniority(title)).toBe(seniority)
  })
})
