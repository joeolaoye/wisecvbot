/**
 * Tier 2 — embedding similarity. Pure in-memory cosine over the embeddings
 * stored at ingest; the post-tier-1 candidate set is small enough that no
 * vector index is needed at this scale (swap for pgvector `<=>` ordering when
 * it is — see storage/jobs.ts).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface Tier2Candidate<T> {
  job: T
  simScore: number
}

export interface Tier2Job {
  embedding: number[] | null
}

/** Keep jobs at/above `threshold`, ranked by similarity, top-k. */
export function tier2Rank<T extends Tier2Job>(
  profileEmbedding: number[],
  jobs: T[],
  opts: { threshold: number; k: number },
): Tier2Candidate<T>[] {
  return jobs
    .filter((j) => j.embedding !== null)
    .map((j) => ({ job: j, simScore: cosineSimilarity(profileEmbedding, j.embedding!) }))
    .filter((c) => c.simScore >= opts.threshold)
    .sort((a, b) => b.simScore - a.simScore)
    .slice(0, opts.k)
}
