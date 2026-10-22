import type { MatchDelivery } from '../../src/channels/base.js'

describe('Resend passwordless email delivery', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env.APP_URL = 'https://wisecv.example.com'
    process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret'
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.EMAIL_FROM = 'noreply@example.com'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.APP_URL
    delete process.env.TELEGRAM_WEBHOOK_SECRET
    delete process.env.RESEND_API_KEY
    delete process.env.EMAIL_FROM
  })

  test('sends the single-use link through the Resend API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const { sendEmailMagicLink } = await import('../../src/web/email.js')

    await sendEmailMagicLink('person@example.com', 'secret-token')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.resend.com/emails')
    expect(request.headers).toMatchObject({ authorization: 'Bearer re_test_key' })
    const payload = JSON.parse(String(request.body)) as Record<string, unknown>
    expect(payload).toMatchObject({
      from: 'WiseCV <noreply@example.com>',
      to: ['person@example.com'],
      subject: 'Sign in to WiseCV',
    })
    expect(String(payload.text)).toContain(
      'https://wisecv.example.com/api/auth/email/verify?token=secret-token',
    )
  })

  test('fails closed when Resend rejects delivery', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }))
    const { sendEmailMagicLink } = await import('../../src/web/email.js')

    await expect(sendEmailMagicLink('person@example.com', 'secret-token')).rejects.toThrow(
      'Resend delivery failed: 403',
    )
  })

  test('sends multiple recommendations in one daily digest', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const { sendMatchDigestEmail } = await import('../../src/web/email.js')
    const job = {
      id: 11,
      source: 'test',
      externalId: 'job-11',
      title: 'Senior <Platform> Engineer',
      company: 'Example & Co',
      location: 'Remote',
      remote: true,
      salaryMin: 140_000,
      salaryMax: 170_000,
      salaryCurrency: 'USD',
      url: 'https://jobs.example.com/platform',
      roleFamily: 'backend',
      seniority: 'senior',
      skills: ['TypeScript'],
      descriptionText: 'Build reliable systems.',
      dedupeKey: 'example-platform-remote',
      contentHash: 'hash-11',
      embedding: null,
      firstSeen: new Date(),
      lastSeen: new Date(),
    }
    const review = {
      match: true,
      fitScore: 88,
      whyThisFits: ['Strong TypeScript match'],
      redFlags: [],
      questions: [],
    }

    const matches: MatchDelivery[] = [
      { job, review, matchId: 101 },
      {
        job: {
          ...job,
          id: 12,
          externalId: 'job-12',
          title: 'Staff Engineer',
          url: 'javascript:alert(1)',
        },
        review: { ...review, fitScore: 82 },
        matchId: 102,
      },
    ]
    await sendMatchDigestEmail('person@example.com', matches)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    const payload = JSON.parse(String(request.body)) as Record<string, unknown>
    expect(payload.subject).toBe('2 jobs worth your time today')
    expect(String(payload.text)).toContain('Open WiseCV to mark jobs Interested or Not for me')
    expect(String(payload.html)).toContain('Senior &lt;Platform&gt; Engineer')
    expect(String(payload.html)).not.toContain('javascript:alert')
    expect(String(payload.html)).toContain('https://wisecv.example.com/')
  })
})
