import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { webhookCallback, type Bot } from 'grammy'
import { env } from './config/env.js'
import { logger } from './log.js'
import { countCompanies, countJobs } from './storage/jobs.js'
import { deadLetterCount } from './storage/ops.js'

/**
 * The only public surface (behind Caddy TLS): healthz + (when a bot runs) the
 * Telegram webhook. grammY validates the X-Telegram-Bot-Api-Secret-Token
 * header before processing anything.
 */
export function startServer(bot?: Bot): void {
  const webhookPath = `/${env.TELEGRAM_WEBHOOK_PATH.replace(/^\//, '')}`
  // Build the webhook handler ONLY in webhook mode — webhookCallback() disables
  // bot.start() as a side effect, which would break long-polling mode.
  // CV upload + parse + LLM extraction can exceed grammY's default 10s; when
  // it does, answer 200 anyway (onTimeout: 'return') so Telegram doesn't retry
  // the update into the still-running handler — duplicate replies and spend.
  const handleWebhook =
    bot && env.APP_URL
      ? webhookCallback(bot, 'http', {
          secretToken: env.TELEGRAM_WEBHOOK_SECRET,
          onTimeout: 'return',
          timeoutMilliseconds: 120_000,
        })
      : null

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // compare on pathname only — monitors/CDNs append query strings to health probes
      const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : '/'
      if (req.method === 'GET' && pathname === '/healthz') {
        const [jobs, companies, deadLetters] = await Promise.all([
          countJobs(),
          countCompanies(),
          deadLetterCount(),
        ])
        res.writeHead(200, {
          'content-type': 'application/json',
          'access-control-allow-origin': 'https://wisecv.co', // landing page live counter
        })
        res.end(JSON.stringify({ ok: true, jobs, companies, deadLetters }))
        return
      }
      if (req.method === 'POST' && pathname === webhookPath && handleWebhook) {
        await handleWebhook(req, res)
        return
      }
      res.writeHead(404).end()
    } catch (err) {
      logger.error('server_error', { error: String(err).slice(0, 200) })
      res.writeHead(500).end()
    }
  })

  server.listen(env.APP_PORT, () => {
    logger.info('server_listening', { port: env.APP_PORT, webhookPath, bot: Boolean(bot) })
  })
}
