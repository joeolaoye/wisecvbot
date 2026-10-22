import type { Bot } from 'grammy'
import { formatMatchMessage } from '../channels/base.js'
import { telegramNotifier } from '../channels/telegram.js'
import type { Notifier } from '../channels/base.js'
import { appendWebMessage } from './chat.js'
import { logger } from '../log.js'
import { verifiedEmailForSubscriber } from './auth.js'
import { sendMatchDigestEmail } from './email.js'

function matchActions(matchId: number, jobUrl: string) {
  return [
    { label: 'View job', value: `url:${jobUrl}` },
    { label: 'Interested', value: `feedback:${matchId}:interested` },
    { label: 'Not for me', value: `feedback:${matchId}:rejected` },
  ]
}

async function mirrorMatchesToWeb(
  subscriberId: number,
  matches: Parameters<Notifier['deliverMatches']>[1],
): Promise<void> {
  for (const { job, review, matchId } of matches) {
    await appendWebMessage(
      subscriberId,
      'assistant',
      formatMatchMessage(job, review),
      matchActions(matchId, job.url),
    )
  }
}

/** Route delivery by the subscriber's channel and mirror every alert into web chat. */
export function webAwareNotifier(bot: Bot): Notifier {
  const telegram = telegramNotifier(bot)
  return {
    async deliverMatches(sub, matches) {
      if (sub.channel === 'telegram') {
        const deliveredIds = await telegram.deliverMatches(sub, matches)
        const delivered = matches.filter(({ matchId }) => deliveredIds.includes(matchId))
        // The Telegram delivery is authoritative. A web-history mirror failure
        // must not cause a retry that sends the same Telegram alert twice.
        try {
          await mirrorMatchesToWeb(sub.id, delivered)
        } catch (error) {
          logger.warn('web_match_mirror_failed', {
            subscriberId: sub.id,
            error: String(error).slice(0, 160),
          })
        }
        return deliveredIds
      }
      if (sub.channel !== 'web') {
        logger.error('match_delivery_unsupported_channel', {
          subscriberId: sub.id,
          channel: sub.channel,
        })
        return []
      }
      const email = await verifiedEmailForSubscriber(sub.id)
      if (!email) {
        logger.error('web_match_email_missing', { subscriberId: sub.id })
        return []
      }
      try {
        await sendMatchDigestEmail(email, matches)
      } catch (error) {
        logger.error('web_match_email_failed', {
          subscriberId: sub.id,
          error: String(error).slice(0, 160),
        })
        return []
      }
      // Email is authoritative. Mirroring after acceptance prevents a DB blip
      // from causing a duplicate digest on the next retry.
      try {
        await mirrorMatchesToWeb(sub.id, matches)
      } catch (error) {
        logger.warn('web_match_mirror_failed', {
          subscriberId: sub.id,
          error: String(error).slice(0, 160),
        })
      }
      return matches.map(({ matchId }) => matchId)
    },
  }
}
