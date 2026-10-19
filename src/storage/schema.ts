import {
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core'
import type { JobStructured, MatchReview, Profile } from '../domain/job.js'

/** Postgres bytea for the envelope-encrypted CV blob. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const jobs = pgTable(
  'jobs',
  {
    id: serial('id').primaryKey(),
    /** "greenhouse:stripe" */
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    company: text('company').notNull(),
    title: text('title').notNull(),
    /** Canonical ATS URL — the only link ever shown to subscribers. */
    url: text('url').notNull(),
    location: text('location'),
    remote: boolean('remote').notNull().default(false),
    salaryMin: integer('salary_min'),
    salaryMax: integer('salary_max'),
    salaryCurrency: text('salary_currency').notNull().default('USD'),
    descriptionText: text('description_text').notNull(),
    roleFamily: text('role_family').notNull(),
    seniority: text('seniority').notNull(),
    skills: jsonb('skills').$type<string[]>().notNull().default([]),
    dedupeKey: text('dedupe_key').notNull(),
    contentHash: text('content_hash').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('jobs_dedupe_key_uq').on(t.dedupeKey),
    index('jobs_last_seen_idx').on(t.lastSeen),
    index('jobs_role_family_idx').on(t.roleFamily),
  ],
)

export type JobStatuses =
  | 'new' // messaged /start, no consent yet
  | 'consented' // agreed, awaiting CV
  | 'awaiting_cv' // asked for CV (same behavior as consented; distinct for analytics)
  | 'parsing' // CV received, extraction running
  | 'awaiting_confirmation' // profile drafted, confirmation card sent
  | 'active' // confirmed — matching runs
  | 'paused'
  | 'deleted'

export const subscribers = pgTable(
  'subscribers',
  {
    id: serial('id').primaryKey(),
    /** v1: 'telegram'; v2 adds 'whatsapp' — channels are separate rows, never merged. */
    channel: text('channel').notNull().default('telegram'),
    channelUserId: text('channel_user_id').notNull(),
    status: text('status').$type<JobStatuses>().notNull().default('new'),
    /** Ratified profile — written by the confirmation flow, the only input to matching. */
    profile: jsonb('profile').$type<Profile>(),
    profileEmbedding: vector('profile_embedding', { dimensions: 1536 }),
    /** Envelope-encrypted CV file (AES-256-GCM; key lives in env, never in the DB). */
    cvBlob: bytea('cv_blob'),
    cvFilename: text('cv_filename'),
    matchThreshold: doublePrecision('match_threshold').notNull().default(0.62),
    /** Analytics is pseudonymous + disclosed; this is the per-subscriber opt-out. */
    analyticsOptOut: boolean('analytics_opt_out').notNull().default(false),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('subscribers_channel_user_uq').on(t.channel, t.channelUserId)],
)

/**
 * Match lifecycle: `pending` = row reserved but delivery not yet confirmed —
 * retried on the next run; only `sent` counts against allowances and
 * no-resend windows. Crash-safe by design: a failed send never burns a job.
 */
export type MatchStatus = 'pending' | 'sent' | 'interested' | 'rejected' | 'wrong_direction'

export const matches = pgTable(
  'matches',
  {
    id: serial('id').primaryKey(),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    simScore: doublePrecision('sim_score').notNull().default(0),
    fitScore: integer('fit_score'),
    rationale: jsonb('rationale').$type<MatchReview>(),
    status: text('status').$type<MatchStatus>().notNull().default('sent'),
    feedback: text('feedback'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('matches_sub_job_uq').on(t.subscriberId, t.jobId),
    index('matches_sub_sent_idx').on(t.subscriberId, t.sentAt),
  ],
)

/** Every bot interaction — IDs and statuses only, never content. */
export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    subscriberId: integer('subscriber_id').references(() => subscribers.id, {
      onDelete: 'cascade',
    }),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('events_created_idx').on(t.createdAt)],
)

/** One row per day; hard gate checked before every LLM call. */
export const llmSpend = pgTable('llm_spend', {
  day: text('day').primaryKey(), // YYYY-MM-DD (UTC)
  cents: integer('cents').notNull().default(0),
})

export const deadLetters = pgTable('dead_letters', {
  id: serial('id').primaryKey(),
  source: text('source').notNull(),
  error: text('error').notNull(),
  payloadSample: text('payload_sample'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Passwordless web identities. Phone numbers are normalized E.164 values. */
export const webAuthIdentities = pgTable('web_auth_identities', {
  phone: text('phone').primaryKey(),
  subscriberId: integer('subscriber_id')
    .notNull()
    .unique()
    .references(() => subscribers.id, { onDelete: 'cascade' }),
  verifiedVia: text('verified_via').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
})

export const webAuthChallenges = pgTable(
  'web_auth_challenges',
  {
    tokenHash: text('token_hash').primaryKey(),
    phone: text('phone').notNull(),
    method: text('method').notNull(),
    codeHash: text('code_hash'),
    telegramUserId: text('telegram_user_id'),
    subscriberId: integer('subscriber_id').references(() => subscribers.id, {
      onDelete: 'cascade',
    }),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('web_auth_challenges_expires_idx').on(t.expiresAt)],
)

/** Verified email identities are separate from phone identities so either can sign in alone. */
export const webEmailIdentities = pgTable('web_email_identities', {
  email: text('email').primaryKey(),
  subscriberId: integer('subscriber_id')
    .notNull()
    .unique()
    .references(() => subscribers.id, { onDelete: 'cascade' }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Single-use, hashed magic-link tokens. Raw tokens exist only in the email being sent. */
export const webEmailChallenges = pgTable(
  'web_email_challenges',
  {
    tokenHash: text('token_hash').primaryKey(),
    email: text('email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('web_email_challenges_email_idx').on(t.email),
    index('web_email_challenges_expires_idx').on(t.expiresAt),
  ],
)

export const webSessions = pgTable(
  'web_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('web_sessions_subscriber_idx').on(t.subscriberId)],
)

export const webMessages = pgTable(
  'web_messages',
  {
    id: serial('id').primaryKey(),
    subscriberId: integer('subscriber_id')
      .notNull()
      .references(() => subscribers.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    body: text('body').notNull(),
    actions: jsonb('actions').$type<Array<{ label: string; value: string }>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('web_messages_subscriber_idx').on(t.subscriberId, t.createdAt)],
)

export const webConversations = pgTable('web_conversations', {
  subscriberId: integer('subscriber_id')
    .primaryKey()
    .references(() => subscribers.id, { onDelete: 'cascade' }),
  state: text('state').notNull().default('idle'),
  draft: jsonb('draft').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Job = typeof jobs.$inferSelect
export type Subscriber = typeof subscribers.$inferSelect
export type Match = typeof matches.$inferSelect
export type { JobStructured }
