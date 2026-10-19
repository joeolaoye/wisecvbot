import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'
import { env } from '../config/env.js'

const client = new SESv2Client({ region: env.EMAIL_AWS_REGION, maxAttempts: 3 })

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  )
}

export function buildEmailMagicLink(token: string): string {
  if (!env.APP_URL) throw new Error('APP_URL is required for email authentication')
  const url = new URL('/api/auth/email/verify', env.APP_URL)
  url.searchParams.set('token', token)
  return url.toString()
}

export async function sendEmailMagicLink(email: string, token: string): Promise<void> {
  if (!env.EMAIL_FROM) throw new Error('EMAIL_FROM is required for email authentication')
  const magicLink = buildEmailMagicLink(token)
  const safeLink = escapeHtml(magicLink)
  await client.send(
    new SendEmailCommand({
      FromEmailAddress: `WiseCV <${env.EMAIL_FROM}>`,
      Destination: { ToAddresses: [email] },
      Content: {
        Simple: {
          Subject: { Data: 'Sign in to WiseCV', Charset: 'UTF-8' },
          Body: {
            Text: {
              Data: `Open this secure link to sign in to WiseCV:\n\n${magicLink}\n\nThis link expires in 10 minutes and can only be used once. If you did not request it, you can ignore this email.`,
              Charset: 'UTF-8',
            },
            Html: {
              Data: `<div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6"><h1 style="font-size:24px">Sign in to WiseCV</h1><p>Use this secure link to open your job agent:</p><p><a href="${safeLink}" style="display:inline-block;background:#1d6f52;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">Open WiseCV</a></p><p style="color:#687386;font-size:14px">This link expires in 10 minutes and can only be used once. If you did not request it, you can ignore this email.</p></div>`,
              Charset: 'UTF-8',
            },
          },
        },
      },
    }),
  )
}
