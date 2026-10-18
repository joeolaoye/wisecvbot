import { eq } from 'drizzle-orm'
import { env } from '../config/env.js'
import {
  ROLE_FAMILIES,
  SENIORITIES,
  profileSchema,
  type RoleFamily,
  type Seniority,
} from '../domain/job.js'
import { budgetExhausted } from '../llm.js'
import { embedProfile } from '../pipeline/embed.js'
import { extractProfileFromCv } from '../pipeline/extract.js'
import { encryptCv } from '../security/encryption.js'
import { db } from '../storage/db.js'
import { getMatch, logEvent, markFeedback } from '../storage/ops.js'
import { webConversations, webMessages } from '../storage/schema.js'
import {
  activate,
  adjustThreshold,
  clearCv,
  getById,
  purge,
  setConsent,
  setCv,
  setProfileDraft,
  setStatus,
  updateProfile,
} from '../storage/subscribers.js'
import { formatProfileCard } from '../channels/base.js'
import { extractCvText, parseProfileEdits } from '../channels/telegram.js'

export interface WebAction {
  label: string
  value: string
}

export interface WebChatMessage {
  id: number
  role: string
  body: string
  actions: WebAction[] | null
  createdAt: Date
}

const welcome = `Hi, I'm WiseBot 👋 I find tech jobs that fit you — up to ${env.MAX_MATCH_ALERTS_PER_DAY} a day, each reviewed by AI. I store your CV and the profile I build from it. You can pause or delete everything anytime.`

const cvPrompt = 'Great. Upload your CV — PDF or Word.'

const roleActions = ROLE_FAMILIES.filter((role) => role !== 'other').map((role) => ({
  label: role,
  value: `role:${role}`,
}))

const seniorityActions = SENIORITIES.slice(0, 5).map((level) => ({
  label: level,
  value: `seniority:${level}`,
}))

export async function appendWebMessage(
  subscriberId: number,
  role: 'assistant' | 'user',
  body: string,
  actions: WebAction[] | null = null,
): Promise<void> {
  await db.insert(webMessages).values({ subscriberId, role, body, actions })
}

async function conversation(subscriberId: number) {
  const [row] = await db
    .insert(webConversations)
    .values({ subscriberId })
    .onConflictDoNothing()
    .returning()
  if (row) return row
  const [existing] = await db
    .select()
    .from(webConversations)
    .where(eq(webConversations.subscriberId, subscriberId))
    .limit(1)
  if (!existing) throw new Error('web conversation missing')
  return existing
}

async function setConversation(
  subscriberId: number,
  state: string,
  draft: Record<string, unknown> = {},
): Promise<void> {
  await db
    .insert(webConversations)
    .values({ subscriberId, state, draft })
    .onConflictDoUpdate({
      target: webConversations.subscriberId,
      set: { state, draft, updatedAt: new Date() },
    })
}

export async function bootstrapChat(subscriberId: number): Promise<WebChatMessage[]> {
  const existing = await listWebMessages(subscriberId)
  if (existing.length > 0) return existing
  const sub = await getById(subscriberId)
  if (!sub) return []
  if (sub.status === 'new') {
    await appendWebMessage(sub.id, 'assistant', welcome, [
      { label: 'Agree & continue', value: 'consent:yes' },
      { label: 'No thanks', value: 'consent:no' },
    ])
  } else if (sub.profile) {
    await appendWebMessage(sub.id, 'assistant', formatProfileCard(sub.profile))
    await appendWebMessage(
      sub.id,
      'assistant',
      sub.status === 'paused'
        ? 'Alerts are paused. Resume when you are ready.'
        : "You're all set — matches will appear here and in Telegram if you verified there.",
      [
        {
          label: sub.status === 'paused' ? 'Resume alerts' : 'Pause alerts',
          value: sub.status === 'paused' ? 'resume' : 'pause',
        },
        { label: 'Edit profile', value: 'profile:edit' },
      ],
    )
  } else {
    await appendWebMessage(sub.id, 'assistant', cvPrompt, [
      { label: 'No CV handy', value: 'registration:nocv' },
    ])
  }
  return listWebMessages(subscriberId)
}

export async function listWebMessages(subscriberId: number): Promise<WebChatMessage[]> {
  return db
    .select()
    .from(webMessages)
    .where(eq(webMessages.subscriberId, subscriberId))
    .orderBy(webMessages.createdAt)
    .limit(200)
}

export async function handleWebAction(subscriberId: number, action: string): Promise<void> {
  const sub = await getById(subscriberId)
  if (!sub) throw new Error('account not found')

  if (action === 'consent:yes') {
    await appendWebMessage(sub.id, 'user', 'Agree & continue')
    await setConsent(sub.id)
    await setStatus(sub.id, 'awaiting_cv')
    await logEvent(sub.id, 'consent_granted', { channel: 'web' })
    await appendWebMessage(sub.id, 'assistant', cvPrompt, [
      { label: 'No CV handy', value: 'registration:nocv' },
    ])
    return
  }
  if (action === 'consent:no' || action === 'delete') {
    await purge(sub.id)
    return
  }
  if (action === 'registration:nocv') {
    await appendWebMessage(sub.id, 'user', 'I’ll answer a few questions')
    await setConversation(sub.id, 'role')
    await appendWebMessage(sub.id, 'assistant', 'What kind of role are you after?', roleActions)
    return
  }
  if (action.startsWith('role:')) {
    const role = action.slice(5) as RoleFamily
    if (!(ROLE_FAMILIES as readonly string[]).includes(role)) throw new Error('invalid role')
    await setConversation(sub.id, 'seniority', { role })
    await appendWebMessage(sub.id, 'user', role)
    await appendWebMessage(sub.id, 'assistant', 'What level?', seniorityActions)
    return
  }
  if (action.startsWith('seniority:')) {
    const level = action.slice(10) as Seniority
    if (!(SENIORITIES as readonly string[]).includes(level)) throw new Error('invalid seniority')
    const convo = await conversation(sub.id)
    await setConversation(sub.id, 'skills', { ...convo.draft, seniority: level })
    await appendWebMessage(sub.id, 'user', level)
    await appendWebMessage(sub.id, 'assistant', 'List your top skills, comma-separated.')
    return
  }
  if (action === 'confirm:yes') {
    await appendWebMessage(sub.id, 'user', 'Looks right')
    await appendWebMessage(sub.id, 'assistant', 'Salary floor?', [
      { label: '<$80k', value: 'salary:80000' },
      { label: '$80–120k', value: 'salary:120000' },
      { label: '$120–160k', value: 'salary:160000' },
      { label: '$160k+', value: 'salary:200000' },
      { label: 'Skip', value: 'salary:skip' },
    ])
    return
  }
  if (action === 'confirm:wrongcv') {
    await clearCv(sub.id)
    await setStatus(sub.id, 'awaiting_cv')
    await appendWebMessage(sub.id, 'assistant', cvPrompt, [
      { label: 'No CV handy', value: 'registration:nocv' },
    ])
    return
  }
  if (action === 'profile:edit' || action === 'confirm:edit') {
    await setConversation(sub.id, 'profile_edit')
    await appendWebMessage(
      sub.id,
      'assistant',
      'Send edits like:\nseniority: staff\nskills: +Rust -PHP\nsalary: 160k\nremote: only',
    )
    return
  }
  if (action.startsWith('salary:') && sub.profile) {
    const raw = action.slice(7)
    const profile = { ...sub.profile, salaryFloor: raw === 'skip' ? null : Number(raw) }
    await updateProfile(sub.id, profile)
    await appendWebMessage(
      sub.id,
      'user',
      raw === 'skip' ? 'No salary floor' : `$${Number(raw).toLocaleString()}`,
    )
    await appendWebMessage(sub.id, 'assistant', 'Remote only, or open to on-site?', [
      { label: 'Remote only', value: 'remote:only' },
      { label: 'Open to on-site', value: 'remote:open' },
    ])
    return
  }
  if (action.startsWith('remote:') && sub.profile) {
    const profile = { ...sub.profile, remoteOnly: action === 'remote:only' }
    const embedding = await embedProfile(profile)
    await activate(sub.id, profile, embedding)
    await setConversation(sub.id, 'idle')
    await logEvent(sub.id, 'registration_complete', { channel: 'web' })
    await appendWebMessage(
      sub.id,
      'assistant',
      `You're set ✅ Your first matches land within 24 hours — at most ${env.MAX_MATCH_ALERTS_PER_DAY} a day.`,
      [
        { label: 'Edit profile', value: 'profile:edit' },
        { label: 'Pause alerts', value: 'pause' },
      ],
    )
    return
  }
  if (action === 'pause') {
    await setStatus(sub.id, 'paused')
    await appendWebMessage(sub.id, 'assistant', 'Paused ⏸ No more alerts.', [
      { label: 'Resume alerts', value: 'resume' },
    ])
    return
  }
  if (action === 'resume') {
    await setStatus(sub.id, 'active')
    await appendWebMessage(sub.id, 'assistant', "Resumed ▶️ You're back in the next match run.", [
      { label: 'Pause alerts', value: 'pause' },
    ])
    return
  }
  if (action.startsWith('feedback:')) {
    const [, rawId, verdict] = action.split(':')
    const matchId = Number(rawId)
    if (!Number.isSafeInteger(matchId) || !['interested', 'rejected'].includes(verdict ?? '')) {
      throw new Error('invalid feedback')
    }
    const match = await getMatch(matchId)
    if (!match || match.subscriberId !== sub.id) throw new Error('match not found')
    await markFeedback(matchId, verdict as 'interested' | 'rejected')
    await adjustThreshold(sub.id, verdict === 'interested' ? -0.01 : 0.01)
    await appendWebMessage(
      sub.id,
      'assistant',
      verdict === 'interested' ? 'Noted — more like this.' : 'Noted — fewer like this.',
    )
    return
  }
  throw new Error('unsupported action')
}

export async function handleWebText(subscriberId: number, text: string): Promise<void> {
  const value = text.trim().slice(0, 2_000)
  if (!value) return
  const sub = await getById(subscriberId)
  if (!sub) throw new Error('account not found')
  const convo = await conversation(sub.id)
  await appendWebMessage(sub.id, 'user', value)
  if (convo.state === 'skills') {
    const profile = profileSchema.parse({
      roleFamily: convo.draft.role ?? 'other',
      seniority: convo.draft.seniority ?? 'mid',
      skills: value.split(/,\s*/).filter(Boolean).slice(0, 20),
    })
    await setProfileDraft(sub.id, profile)
    await setConversation(sub.id, 'confirm')
    await appendWebMessage(sub.id, 'assistant', formatProfileCard(profile), [
      { label: 'Looks right', value: 'confirm:yes' },
      { label: 'Edit', value: 'confirm:edit' },
    ])
    return
  }
  if (convo.state === 'profile_edit' && sub.profile) {
    const edited = parseProfileEdits(sub.profile, value)
    await updateProfile(sub.id, edited.profile)
    await setConversation(sub.id, 'idle')
    await appendWebMessage(
      sub.id,
      'assistant',
      edited.applied.length
        ? `Updated: ${edited.applied.join('; ')}`
        : 'I could not parse that edit.',
    )
    return
  }
  await appendWebMessage(
    sub.id,
    'assistant',
    'Use the buttons below, or choose Edit profile to change your preferences.',
  )
}

export async function handleWebCv(
  subscriberId: number,
  buffer: Buffer,
  filename: string,
): Promise<void> {
  const sub = await getById(subscriberId)
  if (!sub) throw new Error('account not found')
  if (buffer.length > 20 * 1024 * 1024 || !/\.(pdf|docx?)$/i.test(filename)) {
    throw new Error('Please upload a PDF or Word file under 20MB')
  }
  await appendWebMessage(sub.id, 'user', `Uploaded ${filename}`)
  await appendWebMessage(sub.id, 'assistant', 'Reading your CV… 📖')
  const priorStatus = sub.status
  await setCv(sub.id, encryptCv(buffer), filename)
  try {
    const text = await extractCvText(buffer, filename)
    if (text.replace(/\s/g, '').length < 100)
      throw new Error('That file does not contain enough readable text')
    const profile = await extractProfileFromCv(text)
    if (!profile) {
      const reason = (await budgetExhausted())
        ? 'My AI budget for today is used up. Your CV is saved; use the quick questions or try tomorrow.'
        : 'I could not read that CV. Try again or use the quick questions.'
      await setStatus(
        sub.id,
        priorStatus === 'active' || priorStatus === 'paused' ? priorStatus : 'awaiting_cv',
      )
      await appendWebMessage(sub.id, 'assistant', reason, [
        { label: 'Answer quick questions', value: 'registration:nocv' },
      ])
      return
    }
    await setProfileDraft(sub.id, profile)
    await setConversation(sub.id, 'confirm')
    await appendWebMessage(sub.id, 'assistant', formatProfileCard(profile), [
      { label: 'Looks right', value: 'confirm:yes' },
      { label: 'Edit', value: 'confirm:edit' },
      { label: 'Wrong CV', value: 'confirm:wrongcv' },
    ])
  } catch (error) {
    await setStatus(
      sub.id,
      priorStatus === 'active' || priorStatus === 'paused' ? priorStatus : 'awaiting_cv',
    )
    throw error
  }
}
