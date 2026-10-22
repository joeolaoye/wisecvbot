import { env } from '../config/env.js'
import { formatSalary, type MatchDelivery } from '../channels/base.js'

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

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

async function sendEmail(payload: {
  to: string
  subject: string
  text: string
  html: string
}): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is required for email delivery')
  if (!env.EMAIL_FROM) throw new Error('EMAIL_FROM is required for email delivery')
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `WiseCV <${env.EMAIL_FROM}>`,
      to: [payload.to],
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Resend delivery failed: ${response.status}`)
}

export async function sendEmailMagicLink(email: string, token: string): Promise<void> {
  const magicLink = buildEmailMagicLink(token)
  const safeLink = escapeHtml(magicLink)
  await sendEmail({
    to: email,
    subject: 'Sign in to WiseCV',
    text: `Open this secure link to sign in to WiseCV:\n\n${magicLink}\n\nThis link expires in 10 minutes and can only be used once. If you did not request it, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;color:#111827;line-height:1.6"><h1 style="font-size:24px">Sign in to WiseCV</h1><p>Use this secure link to open your job agent:</p><p><a href="${safeLink}" style="display:inline-block;background:#1d6f52;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">Open WiseCV</a></p><p style="color:#687386;font-size:14px">This link expires in 10 minutes and can only be used once. If you did not request it, you can ignore this email.</p></div>`,
  })
}

export async function sendMatchDigestEmail(email: string, matches: MatchDelivery[]): Promise<void> {
  if (matches.length === 0) return
  if (!env.APP_URL) throw new Error('APP_URL is required for match email delivery')

  const appUrl = new URL('/', env.APP_URL).toString()
  const subject =
    matches.length === 1
      ? `A job worth your time: ${matches[0]!.job.title.replace(/[\r\n]+/g, ' ').slice(0, 100)}`
      : `${matches.length} jobs worth your time today`
  const textJobs = matches
    .map(({ job, review }, index) => {
      const jobUrl = safeHttpUrl(job.url)
      return [
        `${index + 1}. ${job.title} @ ${job.company}`,
        `${review.fitScore}% fit${job.location ? ` · ${job.location}` : ''}${job.remote ? ' · remote' : ''}`,
        formatSalary(job),
        ...review.whyThisFits.map((reason) => `- ${reason}`),
        review.redFlags.length ? `Flags: ${review.redFlags.join(' · ')}` : null,
        jobUrl,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n')
    })
    .join('\n\n')
  const htmlJobs = matches
    .map(({ job, review }) => {
      const jobUrl = safeHttpUrl(job.url)
      const salary = formatSalary(job)
      const meta = [`${review.fitScore}% fit`, job.location, job.remote ? 'Remote' : null, salary]
        .filter(Boolean)
        .map((value) => escapeHtml(String(value)))
        .join(' · ')
      const reasons = review.whyThisFits.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')
      const flags = review.redFlags.length
        ? `<p style="color:#8a4b08;font-size:14px"><strong>Flags:</strong> ${review.redFlags.map(escapeHtml).join(' · ')}</p>`
        : ''
      const jobButton = jobUrl
        ? `<p><a href="${escapeHtml(jobUrl)}" style="color:#1d6f52;font-weight:700">View job →</a></p>`
        : ''
      return `<section style="border:1px solid #dce2e9;border-radius:14px;padding:18px;margin:16px 0"><h2 style="font-size:18px;margin:0 0 4px">${escapeHtml(job.title)}</h2><p style="margin:0;color:#4b5563">${escapeHtml(job.company)}</p><p style="color:#687386;font-size:14px">${meta}</p><ul style="padding-left:20px">${reasons}</ul>${flags}${jobButton}</section>`
    })
    .join('')

  await sendEmail({
    to: email,
    subject,
    text: `Your WiseCV recommendations\n\n${textJobs}\n\nOpen WiseCV to mark jobs Interested or Not for me:\n${appUrl}`,
    html: `<div style="font-family:Arial,sans-serif;color:#111827;line-height:1.5;max-width:640px;margin:auto"><h1 style="font-size:24px">Your WiseCV recommendations</h1><p>Only the jobs worth your time today.</p>${htmlJobs}<p><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#1d6f52;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">Review and respond in WiseCV</a></p><p style="color:#687386;font-size:13px">Your job cards and action buttons will be waiting when you sign in.</p></div>`,
  })
}
