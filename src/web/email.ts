import { env } from '../config/env.js'

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
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required for email authentication')
  if (!env.EMAIL_FROM) throw new Error('EMAIL_FROM is required for email authentication')
  const magicLink = buildEmailMagicLink(token)
  const safeLink = escapeHtml(magicLink)
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `WiseCV <${env.EMAIL_FROM}>`,
      to: [email],
      subject: 'Sign in to WiseCV',
      text: `Open this secure link to sign in to WiseCV:\n\n${magicLink}\n\nThis link expires in 10 minutes and can only be used once. If you did not request it, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6"><h1 style="font-size:24px">Sign in to WiseCV</h1><p>Use this secure link to open your job agent:</p><p><a href="${safeLink}" style="display:inline-block;background:#1d6f52;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">Open WiseCV</a></p><p style="color:#687386;font-size:14px">This link expires in 10 minutes and can only be used once. If you did not request it, you can ignore this email.</p></div>`,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Resend delivery failed: ${response.status}`)
}
