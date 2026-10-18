import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, gt, isNotNull, lt } from 'drizzle-orm'
import { env } from '../config/env.js'
import { db } from '../storage/db.js'
import { webAuthChallenges, webAuthIdentities, webSessions } from '../storage/schema.js'
import { createIfAbsent, getByChannelUser } from '../storage/subscribers.js'

export type VerificationMethod = 'telegram' | 'whatsapp'

const CHALLENGE_MINUTES = 10

function secret(): string {
  if (!env.WEB_AUTH_SECRET) throw new Error('WEB_AUTH_SECRET is required for web authentication')
  return env.WEB_AUTH_SECRET
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function signed(value: string): string {
  return createHmac('sha256', secret()).update(value).digest('hex')
}

export function normalizePhone(value: string): string | null {
  const phone = value.replace(/[\s()-]/g, '')
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function createChallenge(phone: string, method: VerificationMethod) {
  const token = randomBytes(24).toString('base64url')
  const code = method === 'whatsapp' ? String(randomInt(100000, 1000000)) : null
  const expiresAt = new Date(Date.now() + CHALLENGE_MINUTES * 60_000)
  await db.insert(webAuthChallenges).values({
    tokenHash: sha256(token),
    phone,
    method,
    codeHash: code ? signed(`${token}:${code}`) : null,
    expiresAt,
  })
  return { token, code, expiresAt }
}

export async function beginTelegramChallenge(
  token: string,
  telegramUserId: string,
): Promise<boolean> {
  const [row] = await db
    .update(webAuthChallenges)
    .set({ telegramUserId })
    .where(
      and(
        eq(webAuthChallenges.tokenHash, sha256(token)),
        eq(webAuthChallenges.method, 'telegram'),
        gt(webAuthChallenges.expiresAt, new Date()),
      ),
    )
    .returning({ tokenHash: webAuthChallenges.tokenHash })
  return Boolean(row)
}

export async function completeTelegramChallenge(
  telegramUserId: string,
  sharedPhone: string,
): Promise<boolean> {
  const phone = normalizePhone(sharedPhone.startsWith('+') ? sharedPhone : `+${sharedPhone}`)
  if (!phone) return false
  const [challenge] = await db
    .select()
    .from(webAuthChallenges)
    .where(
      and(
        eq(webAuthChallenges.telegramUserId, telegramUserId),
        eq(webAuthChallenges.phone, phone),
        eq(webAuthChallenges.method, 'telegram'),
        gt(webAuthChallenges.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(webAuthChallenges.createdAt))
    .limit(1)
  if (!challenge || challenge.completedAt) return false

  const [identity] = await db
    .select()
    .from(webAuthIdentities)
    .where(eq(webAuthIdentities.phone, phone))
    .limit(1)
  const subscriber = identity
    ? { id: identity.subscriberId }
    : ((await getByChannelUser('telegram', telegramUserId)) ??
      (await createIfAbsent('telegram', telegramUserId)))

  await db.transaction(async (tx) => {
    if (!identity) {
      await tx.insert(webAuthIdentities).values({
        phone,
        subscriberId: subscriber.id,
        verifiedVia: 'telegram',
      })
    }
    await tx
      .update(webAuthChallenges)
      .set({ subscriberId: subscriber.id, completedAt: new Date() })
      .where(eq(webAuthChallenges.tokenHash, challenge.tokenHash))
  })
  return true
}

export async function verifyWhatsappCode(token: string, code: string): Promise<number | null> {
  const tokenHash = sha256(token)
  const [challenge] = await db
    .select()
    .from(webAuthChallenges)
    .where(
      and(
        eq(webAuthChallenges.tokenHash, tokenHash),
        eq(webAuthChallenges.method, 'whatsapp'),
        gt(webAuthChallenges.expiresAt, new Date()),
      ),
    )
    .limit(1)
  if (!challenge || challenge.completedAt || challenge.attempts >= 5 || !challenge.codeHash)
    return null
  await db
    .update(webAuthChallenges)
    .set({ attempts: challenge.attempts + 1 })
    .where(eq(webAuthChallenges.tokenHash, tokenHash))
  if (!safeEqual(challenge.codeHash, signed(`${token}:${code}`))) return null

  const [identity] = await db
    .select()
    .from(webAuthIdentities)
    .where(eq(webAuthIdentities.phone, challenge.phone))
    .limit(1)
  const subscriber = identity
    ? { id: identity.subscriberId }
    : await createIfAbsent('web', challenge.phone)
  await db.transaction(async (tx) => {
    if (!identity) {
      await tx.insert(webAuthIdentities).values({
        phone: challenge.phone,
        subscriberId: subscriber.id,
        verifiedVia: 'whatsapp',
      })
    }
    await tx
      .update(webAuthChallenges)
      .set({ subscriberId: subscriber.id, completedAt: new Date() })
      .where(eq(webAuthChallenges.tokenHash, tokenHash))
  })
  return subscriber.id
}

export async function consumeCompletedChallenge(token: string): Promise<number | null> {
  const [row] = await db
    .delete(webAuthChallenges)
    .where(
      and(
        eq(webAuthChallenges.tokenHash, sha256(token)),
        gt(webAuthChallenges.expiresAt, new Date()),
        isNotNull(webAuthChallenges.completedAt),
      ),
    )
    .returning({ subscriberId: webAuthChallenges.subscriberId })
  return row?.subscriberId ?? null
}

export async function createSession(subscriberId: number) {
  const token = randomBytes(32).toString('base64url')
  const csrfToken = randomBytes(24).toString('base64url')
  const expiresAt = new Date(Date.now() + env.WEB_SESSION_DAYS * 86_400_000)
  await db.insert(webSessions).values({
    tokenHash: sha256(token),
    subscriberId,
    csrfToken,
    expiresAt,
  })
  return { token, csrfToken, expiresAt }
}

export async function readSession(token: string | null) {
  if (!token) return null
  const [row] = await db
    .select()
    .from(webSessions)
    .where(and(eq(webSessions.tokenHash, sha256(token)), gt(webSessions.expiresAt, new Date())))
    .limit(1)
  return row ?? null
}

export async function deleteSession(token: string): Promise<void> {
  await db.delete(webSessions).where(eq(webSessions.tokenHash, sha256(token)))
}

export async function deleteExpiredAuth(): Promise<void> {
  await db.delete(webAuthChallenges).where(lt(webAuthChallenges.expiresAt, new Date()))
  await db.delete(webSessions).where(lt(webSessions.expiresAt, new Date()))
}

export async function sendWhatsappCode(phone: string, code: string): Promise<void> {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error('WhatsApp verification is not configured')
  }
  const response = await fetch(
    `https://graph.facebook.com/v22.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone.slice(1),
        type: 'template',
        template: {
          name: env.WHATSAPP_AUTH_TEMPLATE_NAME,
          language: { code: env.WHATSAPP_AUTH_TEMPLATE_LANGUAGE },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            {
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [{ type: 'text', text: code }],
            },
          ],
        },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (!response.ok) throw new Error(`WhatsApp verification send failed: ${response.status}`)
}
