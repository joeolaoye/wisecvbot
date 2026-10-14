import { and, eq, sql } from 'drizzle-orm'
import { db } from './db.js'
import { subscribers, type JobStatuses, type Subscriber } from './schema.js'
import type { Profile } from '../domain/job.js'

export async function getByChannelUser(
  channel: string,
  channelUserId: string,
): Promise<Subscriber | null> {
  const [row] = await db
    .select()
    .from(subscribers)
    .where(and(eq(subscribers.channel, channel), eq(subscribers.channelUserId, channelUserId)))
    .limit(1)
  return row ?? null
}

export async function createIfAbsent(channel: string, channelUserId: string): Promise<Subscriber> {
  const [row] = await db
    .insert(subscribers)
    .values({ channel, channelUserId })
    .onConflictDoUpdate({
      target: [subscribers.channel, subscribers.channelUserId],
      set: { updatedAt: new Date() },
    })
    .returning()
  if (!row) throw new Error('createIfAbsent returned no row')
  return row
}

export async function setStatus(id: number, status: JobStatuses): Promise<void> {
  await db.update(subscribers).set({ status, updatedAt: new Date() }).where(eq(subscribers.id, id))
}

export async function setConsent(id: number): Promise<void> {
  await db
    .update(subscribers)
    .set({ consentAt: new Date(), status: 'consented', updatedAt: new Date() })
    .where(eq(subscribers.id, id))
}

export async function setCv(id: number, blob: Buffer, filename: string): Promise<void> {
  await db
    .update(subscribers)
    .set({ cvBlob: blob, cvFilename: filename, status: 'parsing', updatedAt: new Date() })
    .where(eq(subscribers.id, id))
}

export async function clearCv(id: number): Promise<void> {
  await db
    .update(subscribers)
    .set({ cvBlob: null, cvFilename: null, updatedAt: new Date() })
    .where(eq(subscribers.id, id))
}

/** Draft written after CV parse — becomes live only when the user ratifies it. */
export async function setProfileDraft(id: number, profile: Profile): Promise<void> {
  await db
    .update(subscribers)
    .set({ profile, status: 'awaiting_confirmation', updatedAt: new Date() })
    .where(eq(subscribers.id, id))
}

export async function activate(id: number, profile: Profile, embedding: number[] | null): Promise<void> {
  await db
    .update(subscribers)
    .set({ profile, profileEmbedding: embedding, status: 'active', updatedAt: new Date() })
    .where(eq(subscribers.id, id))
}

export async function updateProfile(id: number, profile: Profile): Promise<void> {
  await db.update(subscribers).set({ profile, updatedAt: new Date() }).where(eq(subscribers.id, id))
}

export async function setEmbedding(id: number, embedding: number[]): Promise<void> {
  await db
    .update(subscribers)
    .set({ profileEmbedding: embedding, updatedAt: new Date() })
    .where(eq(subscribers.id, id))
}

/** Feedback nudges the per-subscriber similarity threshold, clamped to [0.35, 0.9]. */
export async function adjustThreshold(id: number, delta: number): Promise<void> {
  await db
    .update(subscribers)
    .set({
      matchThreshold: sql`greatest(0.35, least(0.9, ${subscribers.matchThreshold} + ${delta}))`,
      updatedAt: new Date(),
    })
    .where(eq(subscribers.id, id))
}

/** GDPR-style purge: row dies, events/matches cascade. Verified against the DB, not the UI. */
export async function purge(id: number): Promise<void> {
  await db.delete(subscribers).where(eq(subscribers.id, id))
}

export async function activeSubscribers(): Promise<Subscriber[]> {
  return db.select().from(subscribers).where(eq(subscribers.status, 'active'))
}
