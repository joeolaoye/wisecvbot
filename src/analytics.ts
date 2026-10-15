import { PostHog } from 'posthog-node'
import { env } from './config/env.js'
import { logger } from './log.js'

/**
 * Product analytics — PostHog, optional by key like every other integration.
 *
 * Rules (they are the product's public promises — see README/threat-model):
 *  - PSEUDONYMOUS: distinctId is the numeric subscriber id ("sub_42"). No
 *    Telegram ids, names, CV content, message text, job titles, or companies
 *    ever leave the instance.
 *  - DISCLOSED + OPT-OUT: the bot's privacy copy mentions anonymous usage
 *    counting; /analytics turns it off per subscriber (analyticsOptOut).
 *  - OFF BY DEFAULT for self-hosters: no POSTHOG_API_KEY → every call is a
 *    no-op. The flagship operator opts in by setting the key.
 *
 * Event catalogue (snake_case, stable — dashboards depend on them):
 *   consent_granted · cv_uploaded · cv_parse_failed · manual_fallback_done
 *   profile_confirmed · profile_edited · match_delivered · feedback_tapped
 *   wrong_direction · tailor_tapped · profile_viewed · paused · resumed
 *   purge_requested · analytics_toggled
 *   system: ingest_run · match_run  (distinctId "system")
 */

let client: PostHog | null = null
let disabled = false

function getClient(): PostHog | null {
  if (disabled) return null
  if (!env.POSTHOG_API_KEY) return null
  if (!client) {
    client = new PostHog(env.POSTHOG_API_KEY, { host: env.POSTHOG_HOST })
  }
  return client
}

export interface TrackableSubscriber {
  id: number
  analyticsOptOut?: boolean
}

/** Fire-and-forget capture. Never throws — analytics must not break product flows. */
export function track(
  sub: TrackableSubscriber | null,
  event: string,
  properties?: Record<string, unknown>,
): void {
  try {
    const ph = getClient()
    if (!ph) return
    if (sub?.analyticsOptOut) return
    ph.capture({
      distinctId: sub ? `sub_${sub.id}` : 'system',
      event,
      properties: properties ?? {},
    })
  } catch (err) {
    logger.warn('analytics_capture_failed', { error: String(err).slice(0, 120) })
  }
}

/** Flush pending events (shutdown, CLI exits). Safe when analytics is off. */
export async function closeAnalytics(): Promise<void> {
  if (client) {
    await client.shutdown()
    client = null
  }
}

/** Test seam: hard-disable for the process lifetime. */
export function disableAnalytics(): void {
  disabled = true
}
