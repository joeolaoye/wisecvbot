import type { Bot } from 'grammy'
import { formatMatchMessage } from '../channels/base.js'
import { telegramNotifier } from '../channels/telegram.js'
import type { Notifier } from '../channels/base.js'
import { appendWebMessage } from './chat.js'
import { logger } from '../log.js'

/** Route delivery by the subscriber's channel and mirror every alert into web chat. */
export function webAwareNotifier(bot: Bot): Notifier {
  const telegram = telegramNotifier(bot)
  return {
    async deliverMatch(sub, job, review, matchId) {
      if (sub.channel === 'telegram') {
        const sent = await telegram.deliverMatch(sub, job, review, matchId)
        if (!sent) return false
        // The Telegram delivery is authoritative. A web-history mirror failure
        // must not cause a retry that sends the same Telegram alert twice.
        try {
          await appendWebMessage(sub.id, 'assistant', formatMatchMessage(job, review), [
            { label: 'View job', value: `url:${job.url}` },
            { label: 'Interested', value: `feedback:${matchId}:interested` },
            { label: 'Not for me', value: `feedback:${matchId}:rejected` },
          ])
        } catch (error) {
          logger.warn('web_match_mirror_failed', {
            subscriberId: sub.id,
            error: String(error).slice(0, 160),
          })
        }
        return true
      }
      await appendWebMessage(sub.id, 'assistant', formatMatchMessage(job, review), [
        { label: 'View job', value: `url:${job.url}` },
        { label: 'Interested', value: `feedback:${matchId}:interested` },
        { label: 'Not for me', value: `feedback:${matchId}:rejected` },
      ])
      return true
    },
  }
}
