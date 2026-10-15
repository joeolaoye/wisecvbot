import { Bot, InlineKeyboard, type Context } from 'grammy'
import { env, requireBotEnv } from '../config/env.js'
import {
  ROLE_FAMILIES,
  SENIORITIES,
  profileSchema,
  type MatchReview,
  type Profile,
  type RoleFamily,
  type Seniority,
} from '../domain/job.js'
import { extractProfileFromCv } from '../pipeline/extract.js'
import { embedProfile } from '../pipeline/embed.js'
import { encryptCv } from '../security/encryption.js'
import { budgetExhausted } from '../llm.js'
import { track } from '../analytics.js'
import { getMatch, logEvent, markFeedback } from '../storage/ops.js'
import type { Job } from '../storage/schema.js'
import type { SubscriberLite } from '../storage/subscribers.js'
import {
  adjustThreshold,
  clearCv,
  createIfAbsent,
  getByChannelUser,
  purge,
  setAnalyticsOptOut,
  setCv,
  setConsent,
  setProfileDraft,
  setStatus,
  updateProfile,
} from '../storage/subscribers.js'
import { activate } from '../storage/subscribers.js'
import { formatMatchMessage, formatProfileCard } from './base.js'
import type { Notifier } from './base.js'
import { logger } from '../log.js'

const CHANNEL = 'telegram'
const MAX_CV_BYTES = 20 * 1024 * 1024 // Telegram bot file-download limit

// ── CV text extraction (pdf via unpdf, docx via mammoth) ────────────

export async function extractCvText(buffer: Buffer, filename: string): Promise<string> {
  const isPdf =
    buffer.subarray(0, 4).toString('latin1') === '%PDF' || filename.toLowerCase().endsWith('.pdf')
  if (isPdf) {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    const { text } = await extractText(pdf, { mergePages: true })
    return text
  }
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

// ── Edit parsing ("seniority: staff | skills: +Rust -PHP") ──────────

export function parseProfileEdits(
  profile: Profile,
  text: string,
): { profile: Profile; applied: string[]; ignored: string[] } {
  const applied: string[] = []
  const ignored: string[] = []
  const next: Profile = { ...profile, skills: [...profile.skills], domains: [...profile.domains] }

  for (const rawLine of text.split(/\n|\|/)) {
    const line = rawLine.trim()
    if (!line) continue
    const sep = line.indexOf(':')
    if (sep < 0) {
      ignored.push(line)
      continue
    }
    const field = line.slice(0, sep).trim().toLowerCase()
    const value = line.slice(sep + 1).trim()

    switch (field) {
      case 'seniority':
      case 'level': {
        const s = value.toLowerCase() as Seniority
        if ((SENIORITIES as readonly string[]).includes(s)) {
          next.seniority = s
          applied.push(`seniority → ${s}`)
        } else ignored.push(line)
        break
      }
      case 'role':
      case 'rolefamily': {
        const r = value.toLowerCase() as RoleFamily
        if ((ROLE_FAMILIES as readonly string[]).includes(r)) {
          next.roleFamily = r
          applied.push(`role → ${r}`)
        } else ignored.push(line)
        break
      }
      case 'skills': {
        if (/[+-]/.test(value)) {
          for (const part of value.split(/\s+/)) {
            const t = part.trim()
            if (t.startsWith('+')) next.skills.push(t.slice(1))
            else if (t.startsWith('-')) {
              next.skills = next.skills.filter((s) => s.toLowerCase() !== t.slice(1).toLowerCase())
            }
          }
        } else if (value) {
          next.skills = value.split(/,\s*/)
        }
        next.skills = [...new Set(next.skills)].slice(0, 20)
        applied.push('skills updated')
        break
      }
      case 'domains':
        next.domains = value ? value.split(/,\s*/).slice(0, 6) : []
        applied.push('domains updated')
        break
      case 'location':
        next.location = value || null
        applied.push(`location → ${value || 'any'}`)
        break
      case 'salary':
      case 'floor': {
        if (/none|any/i.test(value)) {
          next.salaryFloor = null
          applied.push('salary floor cleared')
        } else {
          const n = Number(value.replace(/[^0-9]/g, ''))
          if (!Number.isNaN(n) && n >= 1) {
            next.salaryFloor = n < 10000 ? n * 1000 : n // "160" → 160000, "160000" stays
            applied.push(`salary floor → $${next.salaryFloor.toLocaleString('en-US')}`)
          } else ignored.push(line)
        }
        break
      }
      case 'remote':
        if (/only|yes|true/i.test(value)) next.remoteOnly = true
        else if (/any|no|false|open/i.test(value)) next.remoteOnly = false
        applied.push(`remote → ${next.remoteOnly ? 'only' : 'open'}`)
        break
      case 'notes':
        next.notes = value.slice(0, 500)
        applied.push('notes updated')
        break
      default:
        ignored.push(line)
    }
  }
  return { profile: next, applied, ignored }
}

// ── In-flight conversation state ────────────────────────────────────
// Deliberately in-memory: a restart mid-registration asks the user to /start
// again rather than persisting half-answers. Confirmed data lives in the DB only.

const awaitingSkills = new Set<number>()
const awaitingEdit = new Set<number>()
const manualRole = new Map<string, RoleFamily>()
const pendingSeniority = new Map<string, Seniority>()
const recentStarts = new Map<string, number>()

// ── Copy ────────────────────────────────────────────────────────────

const WELCOME = `Hi, I'm WiseBot 👋 I find tech jobs that fit you — up to ${env.MAX_MATCH_ALERTS_PER_DAY} a day, each reviewed by AI.

The deal: I store your CV and the profile I build from it, and I count anonymous usage events (features used, buttons tapped — never message or CV content) to improve the bot. You can see everything (/profile), pause it (/pause), delete it all (/delete), or turn analytics off (/analytics) anytime.`

const CV_PROMPT = 'Great. Send me your CV — PDF or Word.'

const SUCCESS = `You're set ✅ Your first matches land within 24 hours — at most ${env.MAX_MATCH_ALERTS_PER_DAY} a day, each with an AI fit-review.

/profile to see or change anything · /delete to wipe everything. Talk soon 👋`

// ── Keyboards ────────────────────────────────────────────────────────

const consentKeyboard = () =>
  new InlineKeyboard().text('Agree & continue', 'consent:yes').text('No thanks', 'consent:no')

const cvKeyboard = () => new InlineKeyboard().text('No CV handy? Answer 5 questions', 'reg:nocv')

const confirmKeyboard = () =>
  new InlineKeyboard()
    .text('✅ Looks right', 'confirm:yes')
    .text('✏️ Edit', 'confirm:edit')
    .row()
    .text('🔄 Wrong CV', 'confirm:wrongcv')

const salaryKeyboard = (prefix: string) => {
  const kb = new InlineKeyboard()
    .text('<$80k', `${prefix}:80000`)
    .text('$80–120k', `${prefix}:120000`)
    .row()
    .text('$120–160k', `${prefix}:160000`)
    .text('$160k+', `${prefix}:200000`)
    .row()
    .text('Skip', `${prefix}:skip`)
  return kb
}

const remoteKeyboard = (prefix: string) =>
  new InlineKeyboard().text('Remote only', `${prefix}:remote`).text('Open to on-site', `${prefix}:open`)

const roleKeyboard = () => {
  const kb = new InlineKeyboard()
  const families = ROLE_FAMILIES.filter((f) => f !== 'other')
  for (let i = 0; i < families.length; i += 2) {
    const a = families[i]!
    const b = families[i + 1]
    kb.text(a, `mrole:${a}`)
    if (b) kb.text(b, `mrole:${b}`)
    kb.row()
  }
  return kb
}

const seniorityKeyboard = () => {
  const kb = new InlineKeyboard()
  for (const s of SENIORITIES.slice(0, 5)) kb.text(s, `msen:${s}`) // junior…lead
  return kb
}

const matchKeyboard = (matchId: number, jobId: number) =>
  new InlineKeyboard()
    .text('📄 Tailor my CV', `tailor:${jobId}`)
    .text('✅ Interested', `fb:${matchId}:i`)
    .row()
    .text('🙅 Not for me', `fb:${matchId}:n`)
    .text('🔀 Wrong direction', `fb:${matchId}:w`)

// ── Helpers ──────────────────────────────────────────────────────────

function userId(ctx: Context): string {
  const id = String(ctx.from?.id ?? '')
  if (!id) throw new Error('no user id in update')
  return id
}

/**
 * Read-only lookup — no row is created here. The subscriber row (and any
 * stored data) only comes into existence when consent is granted; a stranger
 * who /starts and walks away leaves nothing behind.
 */
async function fetchSub(ctx: Context): Promise<SubscriberLite | null> {
  return getByChannelUser(CHANNEL, userId(ctx))
}

async function ensureSub(ctx: Context): Promise<SubscriberLite> {
  return createIfAbsent(CHANNEL, userId(ctx))
}

function clearManualState(sub: SubscriberLite | null): void {
  if (sub) {
    awaitingSkills.delete(sub.id)
    awaitingEdit.delete(sub.id)
    manualRole.delete(sub.channelUserId)
    pendingSeniority.delete(sub.channelUserId)
  }
}

function sendConfirmationCard(ctx: Context, profile: Profile) {
  return ctx.reply(formatProfileCard(profile), { reply_markup: confirmKeyboard() })
}

async function finalize(ctx: Context, sub: SubscriberLite, profile: Profile): Promise<void> {
  const embedding = await embedProfile(profile)
  await activate(sub.id, profile, embedding)
  await logEvent(sub.id, 'registration_complete')
  await ctx.reply(SUCCESS)
}

/** A failed CV parse must never silently unsubscribe an active user. */
function restoreStatus(sub: SubscriberLite): void {
  const prior = sub.status
  const back =
    prior === 'active' || prior === 'paused' || prior === 'awaiting_confirmation'
      ? prior
      : 'awaiting_cv'
  void setStatus(sub.id, back)
}

// ── Handlers ─────────────────────────────────────────────────────────

async function handleCvUpload(
  ctx: Context,
  sub: SubscriberLite,
  fileId: string,
  filename: string,
): Promise<void> {
  const doc = ctx.message?.document
  const okMime =
    !doc?.mime_type ||
    doc.mime_type === 'application/pdf' ||
    doc.mime_type.includes('wordprocessingml')
  if (!okMime || !/\.(pdf|docx?)$/i.test(filename)) {
    await ctx.reply("Hmm, I can only read PDF or Word files. Try sending it again?")
    return
  }
  if ((doc?.file_size ?? 0) > MAX_CV_BYTES) {
    await ctx.reply('That file is over my 20MB limit — could you send a lighter version?')
    return
  }

  await ctx.reply('Reading your CV… 📖')
  try {
    const token = requireBotEnv()
    const file = await ctx.api.getFile(fileId)
    if (!file.file_path) throw new Error('empty file_path')
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())

    // store FIRST (encrypted); a parse failure never loses the file
    await setCv(sub.id, encryptCv(buffer), filename)
    track(sub, 'cv_uploaded')
    const text = await extractCvText(buffer, filename)

    if (text.replace(/\s/g, '').length < 100) {
      restoreStatus(sub)
      track(sub, 'cv_parse_failed', { reason: 'unreadable' })
      await ctx.reply(
        "I couldn't read much text from that file (scanned/image PDFs trip me up). Try a text-based PDF, or:",
        { reply_markup: cvKeyboard() },
      )
      return
    }

    const profile = await extractProfileFromCv(text)
    if (!profile) {
      restoreStatus(sub)
      track(sub, 'cv_parse_failed', { reason: 'extraction' })
      // honest reason — a spent budget reads as "broken" if we say nothing
      const why = (await budgetExhausted())
        ? "My AI budget for today is used up \u{1F634} I've saved your CV — answer 5 quick questions instead, or try again tomorrow"
        : "Something went wrong reading your CV \u{2014} mind trying again, or answering a few questions instead?"
      await ctx.reply(why, { reply_markup: cvKeyboard() })
      return
    }

    await setProfileDraft(sub.id, profile)
    await logEvent(sub.id, 'cv_parsed', { uncertain: profile.uncertain })
    await sendConfirmationCard(ctx, profile)
  } catch (err) {
    restoreStatus(sub)
    logger.error('cv_flow_failed', { subscriberId: sub.id, error: String(err).slice(0, 200) })
    await ctx.reply('Something broke on my side. Please send the CV once more.')
  }
}

function registerHandlers(bot: Bot) {
  bot.catch((err) => logger.error('bot_error', { error: String(err.error).slice(0, 300) }))

  bot.command('start', async (ctx) => {
    const sub = await fetchSub(ctx)
    clearManualState(sub)
    if (!sub || sub.status === 'new') {
      // nothing is persisted until the consent tap — welcome only. A quick
      // double-tap of /start (or a redelivered update) shouldn't spam two
      // welcome messages.
      const key = userId(ctx)
      const last = recentStarts.get(key) ?? 0
      if (Date.now() - last < 10_000) return
      recentStarts.set(key, Date.now())
      await ctx.reply(WELCOME, { reply_markup: consentKeyboard() })
      return
    }
    if (sub.status === 'active') {
      await ctx.reply("You're all set — matches are flowing. /profile · /pause · /delete")
    } else {
      await ctx.reply(`Let's pick up where we left off. ${CV_PROMPT}`, { reply_markup: cvKeyboard() })
    }
  })

  bot.command('help', (ctx) =>
    ctx.reply(
      [
        'WiseCV commands:',
        '/profile — see & edit what I match against',
        '/pause · /resume — stop/start match alerts',
        '/analytics — anonymous usage counting on/off',
        '/delete — wipe everything (CV included)',
      ].join('\n'),
    ),
  )

  bot.command('analytics', async (ctx) => {
    const sub = await fetchSub(ctx)
    if (!sub) return void ctx.reply("Let's get you set up first — /start")
    await ctx.reply(
      `Anonymous usage counting is ${sub.analyticsOptOut ? 'OFF' : 'ON'} for you.\nWhat gets counted: feature usage and button taps, tied to an anonymous id — never message text, CV content, or your Telegram identity.`,
      {
        reply_markup: new InlineKeyboard()
          .text(sub.analyticsOptOut ? 'Turn ON' : 'Turn OFF', sub.analyticsOptOut ? 'ana:on' : 'ana:off')
          .text('Keep as is', 'ana:noop'),
      },
    )
  })

  bot.callbackQuery('ana:on', async (ctx) => {
    const sub = await ensureSub(ctx)
    await setAnalyticsOptOut(sub.id, false)
    track({ ...sub, analyticsOptOut: false }, 'analytics_toggled', { optOut: false })
    await ctx.answerCallbackQuery('Counting on')
    await ctx.reply('Anonymous counting is back ON. Thanks for helping improve the bot 🙏')
  })

  bot.callbackQuery('ana:off', async (ctx) => {
    const sub = await ensureSub(ctx)
    await setAnalyticsOptOut(sub.id, true)
    await ctx.answerCallbackQuery('Counting off')
    await ctx.reply('Done — no usage events are counted for you from now on.')
  })

  bot.callbackQuery('ana:noop', async (ctx) => {
    await ctx.answerCallbackQuery('Kept as is')
  })

  bot.command('pause', async (ctx) => {
    const sub = await fetchSub(ctx)
    if (!sub) return void ctx.reply("Let's get you set up first — /start")
    if (sub.status === 'active') await setStatus(sub.id, 'paused')
    await logEvent(sub.id, 'pause')
    track(sub, 'paused')
    await ctx.reply('Paused ⏸ No more alerts. /resume when you want back in.')
  })

  bot.command('resume', async (ctx) => {
    const sub = await fetchSub(ctx)
    if (!sub) return void ctx.reply("Let's get you set up first — /start")
    if (sub.status === 'paused') await setStatus(sub.id, 'active')
    await logEvent(sub.id, 'resume')
    track(sub, 'resumed')
    await ctx.reply("Resumed ▶️ You're back in tomorrow's matches.")
  })

  bot.command('profile', async (ctx) => {
    const sub = await fetchSub(ctx)
    if (!sub) return void ctx.reply("Let's get you set up first — /start")
    if (!sub.profile) {
      await ctx.reply(CV_PROMPT, { reply_markup: cvKeyboard() })
      return
    }
    awaitingEdit.add(sub.id)
    track(sub, 'profile_viewed')
    await ctx.reply(formatProfileCard(sub.profile))
    await ctx.reply(
      'To change something, reply with edits like:\nseniority: staff\nskills: +Rust -PHP\nsalary: 160k\nremote: only',
    )
  })

  bot.command('delete', async (ctx) => {
    await fetchSub(ctx) // gate: no account → still show the flow for consistency
    await ctx.reply('Delete your account and ALL data (CV, profile, history)? This cannot be undone.', {
      reply_markup: new InlineKeyboard()
        .text('Yes, delete everything', 'del:yes')
        .text('Keep my account', 'del:no'),
    })
  })

  // ── consent (Stage 1) — the row is born here, not at /start ──
  bot.callbackQuery('consent:yes', async (ctx) => {
    const sub = await ensureSub(ctx)
    await setConsent(sub.id)
    await setStatus(sub.id, 'awaiting_cv')
    await logEvent(sub.id, 'consent_granted')
    track(sub, 'consent_granted')
    await ctx.answerCallbackQuery()
    await ctx.reply(CV_PROMPT, { reply_markup: cvKeyboard() })
  })

  bot.callbackQuery('consent:no', async (ctx) => {
    const sub = await fetchSub(ctx)
    if (sub) {
      await logEvent(sub.id, 'consent_declined')
      await purge(sub.id)
    }
    await ctx.answerCallbackQuery()
    await ctx.reply('No problem — everything is already deleted. The bot stays quiet. 👋')
  })

  bot.callbackQuery('del:yes', async (ctx) => {
    const sub = await fetchSub(ctx)
    if (!sub) return void ctx.answerCallbackQuery('Already gone')
    track(sub, 'purge_requested')
    await purge(sub.id) // events & matches cascade — verified against the DB, not the UI
    await ctx.answerCallbackQuery('Deleted')
    await ctx.reply('Done — CV, profile, and history are gone. /start if you ever come back. 👋')
  })

  bot.callbackQuery('del:no', async (ctx) => {
    await ctx.answerCallbackQuery('Kept')
    await ctx.reply('Kept ✅ Nothing was deleted.')
  })

  // ── no-CV fallback: 5 quick questions (journey doc §5) ──
  bot.callbackQuery('reg:nocv', async (ctx) => {
    const sub = await ensureSub(ctx)
    await setStatus(sub.id, 'awaiting_cv')
    await ctx.answerCallbackQuery()
    await ctx.reply('No problem. What kind of role are you after?', { reply_markup: roleKeyboard() })
  })

  bot.callbackQuery(/^mrole:(.+)$/, async (ctx) => {
    manualRole.set(userId(ctx), (ctx.match?.[1] ?? 'other') as RoleFamily)
    await ctx.answerCallbackQuery()
    await ctx.reply('What level?', { reply_markup: seniorityKeyboard() })
  })

  bot.callbackQuery(/^msen:(.+)$/, async (ctx) => {
    const sub = await ensureSub(ctx)
    pendingSeniority.set(sub.channelUserId, (ctx.match?.[1] ?? 'mid') as Seniority)
    awaitingSkills.add(sub.id)
    await ctx.answerCallbackQuery()
    await ctx.reply('List your top skills, comma-separated (e.g. "Python, AWS, Postgres")')
  })

  bot.callbackQuery(/^mloc2:(.+)$/, async (ctx) => {
    // follow-up: remote preference → finalize (all paths end here)
    const sub = await fetchSub(ctx)
    if (!sub?.profile) return void ctx.answerCallbackQuery()
    const merged: Profile = { ...sub.profile, remoteOnly: ctx.match?.[1] === 'remote' }
    await ctx.answerCallbackQuery()
    await finalize(ctx, sub, merged)
  })

  bot.callbackQuery(/^msal2:(.+)$/, async (ctx) => {
    // follow-up: salary floor → remote question
    const sub = await fetchSub(ctx)
    if (!sub?.profile) return void ctx.answerCallbackQuery()
    const raw = ctx.match?.[1] ?? 'skip'
    const merged: Profile = {
      ...sub.profile,
      salaryFloor: raw === 'skip' ? null : Number(raw),
    }
    await updateProfile(sub.id, merged)
    await ctx.answerCallbackQuery()
    await ctx.reply('Last one — remote only, or open to on-site?', { reply_markup: remoteKeyboard('mloc2') })
  })

  // ── confirmation (Stage 4 — the ratification gate) ──
  bot.callbackQuery('confirm:yes', async (ctx) => {
    const sub = await fetchSub(ctx)
    if (!sub?.profile) {
      await ctx.answerCallbackQuery({ text: 'Profile missing — /start again' })
      return
    }
    await ctx.answerCallbackQuery()
    track(sub, 'profile_confirmed')
    // two quick follow-ups for what CVs (and manual answers) never say
    await ctx.reply('Quick last two — salary floor, I only send jobs at or above it:', {
      reply_markup: salaryKeyboard('msal2'),
    })
  })

  bot.callbackQuery('confirm:edit', async (ctx) => {
    const sub = await fetchSub(ctx)
    if (!sub) return void ctx.answerCallbackQuery()
    awaitingEdit.add(sub.id)
    await ctx.answerCallbackQuery()
    await ctx.reply(
      'Reply with corrections like:\nseniority: staff\nskills: +Rust -PHP\nrole: devops\nsalary: 160k\nremote: only\nlocation: Berlin',
    )
  })

  bot.callbackQuery('confirm:wrongcv', async (ctx) => {
    const sub = await fetchSub(ctx)
    if (!sub) return void ctx.answerCallbackQuery()
    await clearCv(sub.id)
    await setStatus(sub.id, 'awaiting_cv')
    await ctx.answerCallbackQuery()
    await ctx.reply(`Cleared. ${CV_PROMPT}`, { reply_markup: cvKeyboard() })
  })

  // ── match feedback (journey doc §3.5) ──
  bot.callbackQuery(/^fb:(\d+):([inw])$/, async (ctx) => {
    const sub = await ensureSub(ctx)
    const matchId = Number(ctx.match?.[1])
    const verdict = ctx.match?.[2]
    const action = verdict === 'i' ? 'interested' : verdict === 'n' ? 'rejected' : 'wrong_direction'
    await markFeedback(matchId, action)
    await logEvent(sub.id, `feedback_${action}`, { matchId })
    track(sub, 'feedback_tapped', { verdict: action })
    if (verdict === 'i') {
      await adjustThreshold(sub.id, -0.01) // liked it → widen slightly
      await ctx.answerCallbackQuery({ text: 'Noted — more like this.' })
    } else if (verdict === 'n') {
      await adjustThreshold(sub.id, 0.01) // rejected → tighten slightly
      await ctx.answerCallbackQuery({ text: 'Noted — fewer like this.' })
    } else {
      await adjustThreshold(sub.id, 0.03)
      await ctx.answerCallbackQuery()
      await ctx.reply('What was off?', {
        reply_markup: new InlineKeyboard()
          .text('Wrong stack', `wd:${matchId}:stack`)
          .text('Wrong level', `wd:${matchId}:level`)
          .row()
          .text('Wrong industry', `wd:${matchId}:industry`)
          .text('Something else', `wd:${matchId}:other`),
      })
    }
  })

  bot.callbackQuery(/^wd:\d+:(.+)$/, async (ctx) => {
    const sub = await fetchSub(ctx)
    const reason = ctx.match?.[1] ?? 'other'
    const matchId = Number(ctx.match?.[0]?.split(':')[1] ?? 0)
    const match = await getMatch(matchId)
    if (sub?.profile && match) {
      const note = `Avoid: ${reason} (from feedback)`
      await updateProfile(sub.id, {
        ...sub.profile,
        notes: (sub.profile.notes ? `${sub.profile.notes}; ` : '') + note,
      })
    }
    if (sub) await logEvent(sub.id, 'wrong_direction', { matchId, reason })
    track(sub, 'wrong_direction', { reason })
    await ctx.answerCallbackQuery({ text: 'Got it — profile updated.' })
  })

  bot.callbackQuery(/^tailor:\d+$/, async (ctx) => {
    const sub = await fetchSub(ctx)
    track(sub, 'tailor_tapped') // the pricing-demand signal — placeholder or not
    await ctx.answerCallbackQuery()
    await ctx.reply('CV tailoring ships in v0.2 — your confirmed profile is saved and ready for it. 🚧')
  })

  // ── documents (CV upload / re-upload) ──
  bot.on(':document', async (ctx) => {
    const sub = await fetchSub(ctx)
    const doc = ctx.message?.document
    if (!doc) return
    const allowed = ['consented', 'awaiting_cv', 'awaiting_confirmation', 'active', 'paused']
    if (!sub || !allowed.includes(sub.status)) {
      await ctx.reply("Let's do the quick intro first — /start")
      return
    }
    await handleCvUpload(ctx, sub, doc.file_id, doc.file_name ?? 'cv')
  })

  // ── free text (manual-flow skills + profile edits) ──
  bot.on(':text', async (ctx) => {
    const text = ctx.message?.text ?? ''
    if (text.startsWith('/')) return // commands handled above
    const sub = await fetchSub(ctx)
    if (!sub || sub.status === 'new') {
      await ctx.reply("Let's get you set up first — /start")
      return
    }

    if (awaitingSkills.has(sub.id)) {
      awaitingSkills.delete(sub.id)
      const skills = text
        .split(/,\s*/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20)
      const profile = profileSchema.parse({
        roleFamily: (manualRole.get(sub.channelUserId) ?? 'other') as RoleFamily,
        seniority: (pendingSeniority.get(sub.channelUserId) ?? 'mid') as Seniority,
        skills,
      })
      manualRole.delete(sub.channelUserId)
      pendingSeniority.delete(sub.channelUserId)
      await setProfileDraft(sub.id, profile)
      track(sub, 'manual_fallback_done')
      await sendConfirmationCard(ctx, profile)
      return
    }

    if (awaitingEdit.has(sub.id) && sub.profile) {
      awaitingEdit.delete(sub.id)
      const { profile, applied, ignored } = parseProfileEdits(sub.profile, text)
      await updateProfile(sub.id, profile)
      // field names only — values are user content and stay out of the events table
      await logEvent(sub.id, 'profile_edited', { fields: applied.map((a) => a.split(' → ')[0]) })
      track(sub, 'profile_edited', { fields: applied.length })
      await ctx.reply(
        applied.length > 0
          ? `Updated: ${applied.join('; ')}${ignored.length > 0 ? `\n(ignored: ${ignored.join('; ')})` : ''}`
          : 'Nothing I could parse — try "field: value" lines.',
      )
      if (sub.status === 'awaiting_confirmation') await sendConfirmationCard(ctx, profile)
      return
    }

    await ctx.reply('I listen best to buttons and CVs 🙂 — /profile to change your match settings.')
  })
}

// ── Wiring ───────────────────────────────────────────────────────────

export function createBot(): Bot {
  const bot = new Bot(requireBotEnv())
  // Telegram redelivers updates when an ack is missed (restarts, network) —
  // dedupe by update_id so a handler never runs twice for one update
  const seen = new Set<number>()
  const seenOrder: number[] = []
  bot.use((ctx, next) => {
    const id = ctx.update.update_id
    if (seen.has(id)) return
    seen.add(id)
    seenOrder.push(id)
    if (seenOrder.length > 200) {
      const old = seenOrder.shift()
      if (old !== undefined) seen.delete(old)
    }
    return next()
  })
  // per-user sequencing: a double-tap must not run two handlers over the same
  // subscriber row concurrently (promise chain keyed by user id)
  const chains = new Map<string, Promise<unknown>>()
  bot.use((ctx, next) => {
    const key = ctx.from ? `u${ctx.from.id}` : null
    if (!key) return next()
    const prev = chains.get(key) ?? Promise.resolve()
    const run = prev.then(
      () => next() as Promise<unknown>,
      () => next() as Promise<unknown>,
    )
    chains.set(key, run.catch(() => undefined))
    return run
  })
  registerHandlers(bot)
  return bot
}

/** Notifier used by the match orchestrator. */
export function telegramNotifier(bot: Bot): Notifier {
  return {
    async deliverMatch(sub, job: Job, review: MatchReview, matchId: number): Promise<boolean> {
      try {
        await bot.api.sendMessage(sub.channelUserId, formatMatchMessage(job, review), {
          reply_markup: matchKeyboard(matchId, job.id),
          // job text is untrusted — never render link previews from it
          link_preview_options: { is_disabled: true },
        })
        return true
      } catch (err) {
        logger.error('telegram_send_failed', { error: String(err).slice(0, 200) })
        return false
      }
    },
  }
}
