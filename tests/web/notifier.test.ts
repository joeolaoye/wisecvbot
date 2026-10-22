import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MatchDelivery } from '../../src/channels/base.js'

const mocks = vi.hoisted(() => ({
  appendWebMessage: vi.fn(),
  sendMatchDigestEmail: vi.fn(),
  verifiedEmailForSubscriber: vi.fn(),
}))

vi.mock('../../src/web/chat.js', () => ({ appendWebMessage: mocks.appendWebMessage }))
vi.mock('../../src/web/email.js', () => ({ sendMatchDigestEmail: mocks.sendMatchDigestEmail }))
vi.mock('../../src/web/auth.js', () => ({
  verifiedEmailForSubscriber: mocks.verifiedEmailForSubscriber,
}))
vi.mock('../../src/channels/telegram.js', () => ({
  telegramNotifier: () => ({ deliverMatches: vi.fn().mockResolvedValue([]) }),
}))

import { webAwareNotifier } from '../../src/web/notifier.js'

const job = {
  id: 7,
  source: 'test',
  externalId: 'job-7',
  title: 'Backend Engineer',
  company: 'Example',
  url: 'https://jobs.example.com/7',
  location: null,
  remote: true,
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: 'USD',
  roleFamily: 'backend',
  seniority: 'senior',
  skills: ['TypeScript'],
  descriptionText: 'Build APIs.',
  dedupeKey: 'example-backend',
  contentHash: 'hash-7',
  embedding: null,
  firstSeen: new Date(),
  lastSeen: new Date(),
}
const review = {
  match: true,
  fitScore: 86,
  whyThisFits: ['Strong backend fit'],
  redFlags: [],
  questions: [],
}
const matches: MatchDelivery[] = [{ job, review, matchId: 42 }]

describe('web match notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifiedEmailForSubscriber.mockResolvedValue('person@example.com')
    mocks.sendMatchDigestEmail.mockResolvedValue(undefined)
    mocks.appendWebMessage.mockResolvedValue(undefined)
  })

  it('emails a verified web user and persists actionable job cards', async () => {
    const notifier = webAwareNotifier({} as never)

    await expect(
      notifier.deliverMatches(
        { id: 3, channel: 'web', channelUserId: 'person@example.com' },
        matches,
      ),
    ).resolves.toEqual([42])

    expect(mocks.sendMatchDigestEmail).toHaveBeenCalledWith('person@example.com', matches)
    expect(mocks.appendWebMessage).toHaveBeenCalledWith(
      3,
      'assistant',
      expect.stringContaining('Backend Engineer @ Example'),
      [
        { label: 'View job', value: 'url:https://jobs.example.com/7' },
        { label: 'Interested', value: 'feedback:42:interested' },
        { label: 'Not for me', value: 'feedback:42:rejected' },
      ],
    )
  })

  it('keeps matches pending when email delivery fails', async () => {
    mocks.sendMatchDigestEmail.mockRejectedValue(new Error('provider unavailable'))
    const notifier = webAwareNotifier({} as never)

    await expect(
      notifier.deliverMatches(
        { id: 3, channel: 'web', channelUserId: 'person@example.com' },
        matches,
      ),
    ).resolves.toEqual([])
    expect(mocks.appendWebMessage).not.toHaveBeenCalled()
  })
})
