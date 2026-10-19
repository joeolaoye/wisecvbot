import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { env } from '../config/env.js'
import { logger } from '../log.js'
import { getById } from '../storage/subscribers.js'
import {
  cancelEmailChallenge,
  consumeCompletedChallenge,
  consumeEmailChallenge,
  createChallenge,
  createEmailChallenge,
  createSession,
  deleteSession,
  normalizePhone,
  normalizeEmail,
  readSession,
  sendWhatsappCode,
  verifyWhatsappCode,
  type VerificationMethod,
} from './auth.js'
import { sendEmailMagicLink } from './email.js'
import {
  bootstrapChat,
  handleWebAction,
  handleWebCv,
  handleWebText,
  listWebMessages,
} from './chat.js'

const WEB_ROOT = join(process.cwd(), 'web')
const MAX_JSON_BYTES = 16 * 1024
const MAX_CV_BYTES = 20 * 1024 * 1024
const attempts = new Map<string, { count: number; resetAt: number }>()

function json(res: ServerResponse, status: number, value: unknown, headers = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(value))
}

function cookie(req: IncomingMessage, name: string): string | null {
  const entry = req.headers.cookie
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)
  return entry?.[1] ? decodeURIComponent(entry[1]) : null
}

function sessionCookie(token: string, expiresAt: Date): string {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : ''
  return `wisecv_session=${encodeURIComponent(token)}; Path=/; HttpOnly${secure}; SameSite=Lax; Expires=${expiresAt.toUTCString()}`
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  if (env.APP_URL && origin === env.APP_URL) return true
  return env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

function clientKey(req: IncomingMessage): string {
  return String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? 'unknown')
}

function rateLimited(req: IncomingMessage): boolean {
  return rateLimitedKey(`ip:${clientKey(req)}`)
}

function rateLimitedKey(key: string): boolean {
  const now = Date.now()
  if (attempts.size > 10_000) {
    for (const [entry, value] of attempts) if (value.resetAt < now) attempts.delete(entry)
    if (attempts.size > 10_000) attempts.clear()
  }
  const current = attempts.get(key)
  if (!current || current.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 })
    return false
  }
  current.count++
  return current.count > 10
}

async function body(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) throw new Error('request too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > limit) throw new Error('request too large')
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return JSON.parse((await body(req)).toString('utf8')) as Record<string, unknown>
}

async function authenticated(req: IncomingMessage) {
  const token = cookie(req, 'wisecv_session')
  const session = await readSession(token)
  return session && token ? { session, token } : null
}

function csrfValid(req: IncomingMessage, csrfToken: string): boolean {
  return originAllowed(req) && req.headers['x-csrf-token'] === csrfToken
}

async function establishSession(subscriberId: number, res: ServerResponse): Promise<void> {
  const session = await createSession(subscriberId)
  json(
    res,
    200,
    { authenticated: true, csrfToken: session.csrfToken },
    { 'set-cookie': sessionCookie(session.token, session.expiresAt) },
  )
}

async function establishSessionAndRedirect(
  subscriberId: number,
  res: ServerResponse,
): Promise<void> {
  const session = await createSession(subscriberId)
  res.writeHead(303, {
    location: '/',
    'cache-control': 'no-store',
    'set-cookie': sessionCookie(session.token, session.expiresAt),
  })
  res.end()
}

async function serveAsset(pathname: string, res: ServerResponse): Promise<boolean> {
  const allowed =
    pathname === '/'
      ? 'index.html'
      : pathname === '/app.js'
        ? 'app.js'
        : pathname === '/styles.css'
          ? 'styles.css'
          : null
  if (!allowed) return false
  try {
    const content = await readFile(join(WEB_ROOT, allowed))
    const contentType =
      extname(allowed) === '.js'
        ? 'text/javascript'
        : extname(allowed) === '.css'
          ? 'text/css'
          : 'text/html'
    res.writeHead(200, {
      'content-type': `${contentType}; charset=utf-8`,
      'cache-control': allowed === 'index.html' ? 'no-store' : 'public, max-age=3600',
      'content-security-policy':
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    res.end(content)
    return true
  } catch {
    return false
  }
}

export async function handleWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
): Promise<boolean> {
  if (req.method === 'GET' && (await serveAsset(pathname, res))) return true
  if (!pathname.startsWith('/api/')) return false

  if (req.method === 'GET' && pathname === '/api/auth/capabilities') {
    json(res, 200, {
      email: Boolean(env.WEB_AUTH_SECRET && env.APP_URL && env.RESEND_API_KEY && env.EMAIL_FROM),
      telegram: Boolean(env.WEB_AUTH_SECRET && env.TELEGRAM_BOT_USERNAME),
      whatsapp: Boolean(
        env.WEB_AUTH_SECRET && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID,
      ),
    })
    return true
  }

  if (req.method === 'POST' && !originAllowed(req)) {
    json(res, 403, { error: 'origin rejected' })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/auth/start') {
    if (rateLimited(req)) return void json(res, 429, { error: 'Try again in 15 minutes.' }) as never
    const input = await jsonBody(req)
    const phone = normalizePhone(String(input.phone ?? ''))
    const method = String(input.method ?? '') as VerificationMethod
    if (!phone || !['telegram', 'whatsapp'].includes(method)) {
      json(res, 400, { error: 'Use a phone number with country code.' })
      return true
    }
    if (rateLimitedKey(`phone:${phone}`)) {
      json(res, 429, { error: 'Try again in 15 minutes.' })
      return true
    }
    if (!env.WEB_AUTH_SECRET) {
      json(res, 503, { error: 'Web sign-in is not configured yet.' })
      return true
    }
    if (method === 'telegram' && !env.TELEGRAM_BOT_USERNAME) {
      json(res, 503, { error: 'Telegram sign-in is not configured yet.' })
      return true
    }
    if (method === 'whatsapp' && (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID)) {
      json(res, 503, { error: 'WhatsApp sign-in is not configured yet. Use Telegram.' })
      return true
    }
    const challenge = await createChallenge(phone, method)
    if (method === 'whatsapp') {
      if (!challenge.code) throw new Error('verification code missing')
      await sendWhatsappCode(phone, challenge.code)
    }
    json(res, 200, {
      token: challenge.token,
      method,
      telegramUrl:
        method === 'telegram'
          ? `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=web_${challenge.token}`
          : null,
      expiresAt: challenge.expiresAt,
    })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/auth/email/start') {
    if (rateLimited(req)) return void json(res, 429, { error: 'Try again in 15 minutes.' }) as never
    const input = await jsonBody(req)
    const email = normalizeEmail(String(input.email ?? ''))
    if (!email) {
      json(res, 400, { error: 'Enter a valid email address.' })
      return true
    }
    if (rateLimitedKey(`email:${email}`)) {
      json(res, 429, { error: 'Try again in 15 minutes.' })
      return true
    }
    if (!env.WEB_AUTH_SECRET || !env.APP_URL || !env.RESEND_API_KEY || !env.EMAIL_FROM) {
      json(res, 503, { error: 'Email sign-in is not configured yet.' })
      return true
    }
    const challenge = await createEmailChallenge(email)
    try {
      await sendEmailMagicLink(email, challenge.token)
    } catch (error) {
      await cancelEmailChallenge(challenge.token)
      logger.warn('email_auth_delivery_failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
      json(res, 503, { error: 'Email sign-in is temporarily unavailable. Use Telegram for now.' })
      return true
    }
    json(res, 202, {
      sent: true,
      message: 'Check your inbox for a secure sign-in link.',
      expiresAt: challenge.expiresAt,
    })
    return true
  }

  if (req.method === 'GET' && pathname === '/api/auth/email/verify') {
    const subscriberId = await consumeEmailChallenge(url.searchParams.get('token') ?? '')
    if (!subscriberId) {
      res.writeHead(303, { location: '/?email=invalid', 'cache-control': 'no-store' })
      res.end()
      return true
    }
    await establishSessionAndRedirect(subscriberId, res)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/auth/status') {
    const token = url.searchParams.get('token') ?? ''
    const subscriberId = await consumeCompletedChallenge(token)
    if (!subscriberId) {
      json(res, 200, { authenticated: false })
      return true
    }
    await establishSession(subscriberId, res)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/auth/verify') {
    if (rateLimited(req)) return void json(res, 429, { error: 'Try again in 15 minutes.' }) as never
    const input = await jsonBody(req)
    if (rateLimitedKey(`challenge:${String(input.token ?? '')}`)) {
      json(res, 429, { error: 'Try again in 15 minutes.' })
      return true
    }
    const subscriberId = await verifyWhatsappCode(
      String(input.token ?? ''),
      String(input.code ?? ''),
    )
    if (!subscriberId) {
      json(res, 401, { error: 'That code is invalid or expired.' })
      return true
    }
    await establishSession(subscriberId, res)
    return true
  }

  const auth = await authenticated(req)
  if (!auth) {
    json(res, 401, { authenticated: false })
    return true
  }

  if (req.method === 'GET' && pathname === '/api/session') {
    const sub = await getById(auth.session.subscriberId)
    json(res, 200, {
      authenticated: Boolean(sub),
      csrfToken: auth.session.csrfToken,
      status: sub?.status,
    })
    return true
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    if (!csrfValid(req, auth.session.csrfToken))
      return void json(res, 403, { error: 'invalid request' }) as never
    await deleteSession(auth.token)
    json(
      res,
      200,
      { authenticated: false },
      { 'set-cookie': 'wisecv_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' },
    )
    return true
  }
  if (req.method === 'GET' && pathname === '/api/chat') {
    const messages = await bootstrapChat(auth.session.subscriberId)
    json(res, 200, { messages })
    return true
  }
  if (req.method === 'POST' && pathname === '/api/chat/action') {
    if (!csrfValid(req, auth.session.csrfToken))
      return void json(res, 403, { error: 'invalid request' }) as never
    const input = await jsonBody(req)
    await handleWebAction(auth.session.subscriberId, String(input.action ?? ''))
    json(res, 200, { messages: await listWebMessages(auth.session.subscriberId) })
    return true
  }
  if (req.method === 'POST' && pathname === '/api/chat/message') {
    if (!csrfValid(req, auth.session.csrfToken))
      return void json(res, 403, { error: 'invalid request' }) as never
    const input = await jsonBody(req)
    await handleWebText(auth.session.subscriberId, String(input.message ?? ''))
    json(res, 200, { messages: await listWebMessages(auth.session.subscriberId) })
    return true
  }
  if (req.method === 'POST' && pathname === '/api/chat/cv') {
    if (!csrfValid(req, auth.session.csrfToken))
      return void json(res, 403, { error: 'invalid request' }) as never
    const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'cv'))
    await handleWebCv(auth.session.subscriberId, await body(req, MAX_CV_BYTES), filename)
    json(res, 200, { messages: await listWebMessages(auth.session.subscriberId) })
    return true
  }

  json(res, 404, { error: 'not found' })
  return true
}

export function logWebError(error: unknown): void {
  logger.error('web_request_failed', { error: String(error).slice(0, 200) })
}
