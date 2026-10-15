import { closeAnalytics, disableAnalytics, track } from '../src/analytics.js'

describe('analytics (no POSTHOG_API_KEY in test env — every call must no-op safely)', () => {
  test('track never throws for subscriber, system, or opted-out events', () => {
    expect(() => track({ id: 42 }, 'match_delivered', { fitScore: 85 })).not.toThrow()
    expect(() => track(null, 'match_run', { alertsSent: 1 })).not.toThrow()
    expect(() => track({ id: 7, analyticsOptOut: true }, 'tailor_tapped')).not.toThrow()
    expect(() => track({ id: 7 }, 'cv_parse_failed', { reason: 'unreadable' })).not.toThrow()
  })

  test('closeAnalytics is safe when analytics was never enabled', async () => {
    disableAnalytics()
    await expect(closeAnalytics()).resolves.toBeUndefined()
  })
})
