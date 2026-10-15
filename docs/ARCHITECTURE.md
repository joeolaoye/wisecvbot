# Architecture

One host, one Postgres, one Node process (bot + scheduler + webhook server), no queue infrastructure. The full design rationale lives in the project's build-in-public series; this file is the codebase map.

## Module map

| Path | Responsibility |
|---|---|
| `src/config/env.ts` | Zod-validated environment — boot fails loud on bad config |
| `src/config/boards.yaml` | Community-maintained list of ATS job boards (most PRs land here) |
| `src/domain/job.ts` | Canonical schemas: raw jobs, structured jobs, profiles, match reviews |
| `src/ingestion/*` | One adapter per source (greenhouse/lever/ashby/remotive/adzuna); pure `map*()` functions + fetchers; `index.ts` runs the hourly pass |
| `src/pipeline/*` | normalize (salary/remote/role/seniority rules), dedupe, LLM extraction, embeddings |
| `src/matching/*` | tier 1 (SQL-style filters) → tier 2 (pgvector cosine) → tier 3 (LLM fit review) → orchestrator (daily run, ≤3 alerts/subscriber) |
| `src/channels/*` | `base.ts` channel contract + shared formatting; `telegram.ts` implements registration/matches/feedback/commands; `whatsapp.ts` planned (v2) |
| `src/security/*` | CV envelope encryption (AES-256-GCM), injection-guarded prompt framing |
| `src/storage/*` | Drizzle schema + repositories; every mutation goes through these |
| `src/llm.ts` | Single LLM entry point behind a provider registry (OpenAI default, Anthropic/Claude; adding a provider = one registry entry + one `@ai-sdk/*` package). Chat on `LLM_PROVIDER`; embeddings always on the OpenAI-compatible provider (Anthropic has no embeddings API). Hard daily budget gate before every call, 60s timeouts, spend accounting |
| `src/analytics.ts` | Optional PostHog product analytics: key-gated (OFF without `POSTHOG_API_KEY`), pseudonymous event counts only (`sub_<id>` — never message/CV content or Telegram identity), per-subscriber `/analytics` opt-out, never throws |

## Invariants (enforced in code, tested where possible)

1. **Two gates:** nothing persists before consent; nothing becomes "the profile" until the user's confirmation tap. Matching reads only ratified profiles — never raw CVs.
2. **Untrusted text:** job descriptions and CVs only enter prompts inside `<<<UNTRUSTED-DATA` boundaries with a no-tools, no-instructions system prompt. Tier-3 output is Zod-validated; malformed output is discarded.
3. **Canonical links only:** links shown to subscribers come from the ATS record's `url` field, never parsed out of description text. Messages are plain text — no parse_mode, so postings can't inject formatting.
4. **No outbound action without a user tap.** Nothing is ever applied-to or sent on a user's behalf automatically.
5. **Budget is a hard stop:** every LLM call checks the day's spend first; past the cap, calls are skipped (rules-based fallbacks carry the pipeline), never alerted-then-run.
6. **Degrade, don't break:** missing LLM key, exhausted budget, or a dead board each reduce capability gracefully; nothing crashes the run.

## Data model

`jobs` (dedupe key + content hash, structured fields, embedding) · `subscribers` (status machine: new → consented → awaiting_cv → parsing → awaiting_confirmation → active ⇄ paused → deleted; encrypted CV blob; ratified profile + embedding) · `matches` (one per subscriber-job, feedback status) · `events` (IDs only, no PII) · `llm_spend` (daily cents) · `dead_letters` (failed sources).
