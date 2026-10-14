import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { webhookCallback, type Bot } from 'grammy'
import { env } from './config/env.js'
import { logger } from './log.js'
import { countJobs } from './storage/jobs.js'

/**
 * The only public surface (behind Caddy TLS): healthz + the Telegram webhook.
 * grammY validates the X-Telegram-Bot-Api-Secret-Token header before
 * processing anything.
 */
export function startServer(bot: Bot): void {
  const webhookPath = `/${env.TELEGRAM_WEBHOOK_PATH.replace(/^\//, '')}`
  const handleWebhook = webhookCallback(bot, 'http', {
    secretToken: env.TELEGRAM_WEBHOOK_SECRET,
  })

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        const jobs = await countJobs()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, jobs }))
        return
      }
      if (req.method === 'POST' && req.url === webhookPath) {
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
    logger.info('server_listening', { port: env.APP_PORT, webhookPath })
  })
}
