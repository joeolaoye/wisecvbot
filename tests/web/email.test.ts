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
})
