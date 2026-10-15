# WiseCV — Manual Test Cases

> **v2 — updated 2026-10-15 after the first live bot test** (@wise_job_bot, Docker-local).
> Steps marked ✅ *live-verified* were executed against the real Telegram bot and
> OpenAI on 2026-10-15; the fixes they triggered are in the findings log at the bottom.

Two tracks: **A** runs entirely local in Docker with zero external credentials (headless mode — proves the pipeline); **B** is the full user journey with a real bot (proves the product).

---

## Track A — Local Docker, no credentials required (~10 minutes)

> What this proves: image builds, pgvector + migrations apply at boot, 42 boards ingest live, the API surface behaves, the match engine runs against a seeded subscriber.

### A1. Bring the stack up

```bash
cp .env.example .env                     # then set CV_ENCRYPTION_KEY (openssl rand -base64 32)
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up -d --build
```

**Pass criteria:**
- [ ] `ps` → `db` healthy, `app` running
- [ ] App logs: `migrations_applied`, `headless_mode` (when no bot token), `scheduler_started`, `server_listening`
- [ ] Without `TELEGRAM_BOT_TOKEN` this is headless mode (ingest + healthz + scheduler only) — by design

### A2. Health endpoint

```bash
curl -s 'http://localhost:3000/healthz?probe=1' | jq
```

**Pass criteria:**
- [ ] 200 with query strings too (pathname-only routing — monitoring probes append cache-busters)
- [ ] `{"ok":true,"jobs":N,"deadLetters":M}` — both integers
- [ ] `GET /nope` and `POST /healthz` → 404, app stays healthy after both
- [ ] In headless mode `POST /telegram/webhook` → 404 (no bot = no route)

### A3. Provider check + live ingestion

```bash
docker compose -f deploy/docker-compose.yml exec app node dist/cli/llm-check.js
docker compose -f deploy/docker-compose.yml exec app node dist/cli/ingest.js
```

**Pass criteria:**
- [ ] `llm:check`: without a key both paths print "skipped" cleanly (no crash); with `OPENAI_API_KEY`: chat roundtrip ✓ and embedding ✓ at exactly 1536 dimensions
- [ ] Ingest: `sourcesOk` ≥ 40 (a few boards legitimately return zero postings), `jobsNew` in the thousands on first run, `enriched` reflects `MAX_ENRICH_PER_RUN` and available budget
- [ ] Postgres agrees:
  ```bash
  docker compose -f deploy/docker-compose.yml exec db psql -U wisecv -c \
    "select count(*) jobs, count(distinct company) companies, count(*) filter (where embedding is not null) embedded from jobs;"
  ```
- [ ] `healthz` job count matches
- [ ] No PII-shaped content in `logs app`

### A4. Match engine against a seeded subscriber (dry-run — no bot token)

```bash
docker compose -f deploy/docker-compose.yml exec db psql -U wisecv -c "
insert into subscribers (channel, channel_user_id, status, consent_at, profile)
values ('telegram', 'manual-test-001', 'active', now(),
'{\"roleFamily\":\"backend\",\"seniority\":\"senior\",\"skills\":[\"Python\",\"Go\",\"AWS\"],
\"domains\":[],\"yearsExperience\":6,\"location\":null,\"remoteOnly\":false,
\"salaryFloor\":120000,\"notes\":null,\"uncertain\":[]}');"

docker compose -f deploy/docker-compose.yml exec app node dist/cli/match.js
```

**Pass criteria:**
- [ ] Logs show `match_cli_mode: dry-run` (headless) — **anything else sends real messages**
- [ ] `subscribersConsidered: 1`, run completes, no `subscribersFailed`
- [ ] `alertsSent: 0` without an API key is the fail-closed gate (no embeddings → no tier-2 evidence → no unreviewed delivery)
- [ ] With a key + embedded pool: matches appear with rationales; rejection reasons visible as `tier3_rejected` log lines
- [ ] Clean up: `delete from subscribers where channel_user_id='manual-test-001';`

### A5. Restart resilience

```bash
docker compose -f deploy/docker-compose.yml restart app
curl -s http://localhost:3000/healthz
```

**Pass criteria:** [ ] job count unchanged; logs show migrations skip (already applied); `pending` match rows from an interrupted run are delivered first on the next match run.

---

## Track B — Full user journey with a real bot

**Setup:** `.env` with `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY` (+ `LLM_CENTS_PER_1K_TOKENS=0.2` recommended — the default 1 over-estimates ~20× and drains the nominal budget early); `up -d --build`.

| # | Step | Expected result | ✓ |
|---|------|-----------------|---|
| B1 ✅ | Message the bot `/start` | Welcome + privacy copy, consent buttons. Nothing persisted yet (check `subscribers` empty). **Tap /start again within 10s → no second welcome** (double-tap + redelivery guard) | |
| B2 ✅ | Tap **No thanks** | "everything is already deleted" — row count still 0 | |
| B3 ✅ | `/start` → **Agree & continue** | CV prompt + no-CV fallback button; subscriber row now exists with `consent_at` | |
| B4 | Send a PDF/DOCX CV | "Reading your CV… 📖" → confirmation card: role, skills, domains, location, `⚠️` on uncertain fields. `cv_blob` is encrypted binary in psql | |
| B4b ✅ | **Budget-exhausted CV attempt:** set `DAILY_LLM_BUDGET_CENTS=1`, send a CV | Honest message: "My AI budget for today is used up 😴 I've saved your CV — answer 5 quick questions instead, or try again tomorrow" — never a generic "something went wrong" | |
| B5 | **✏️ Edit**, send `seniority: staff` + `skills: +Rust -PHP` | Card re-renders with edits; `profile_edited` event stores field NAMES only | |
| B6 ✅ | **✅ Looks right** → salary → remote buttons | "You're set ✅…" — `status: active`, `profile_embedding` populated (lazily, on first match run) | |
| B7 ✅ | Wait ≤24h **or** trigger: `exec app node dist/cli/match.js` | ≤3 alerts. **Verify on the phone, not just the DB** (see verification discipline below). Each: why-it-fits in **second person** ("technologies you are proficient in"), flags, `🔗` canonical URL only | |
| B8 | Tap **🙅 Not for me** | "Noted — fewer like this"; `match_threshold` +0.01 in DB | |
| B9 | Tap **🔀 Wrong direction** → pick reason | Reason appended to profile notes; threshold +0.03 | |
| B10 | `/profile` | Current card + edit instructions | |
| B11 | `/pause` → `/resume` | Status flips in DB both times | |
| B12 | `/delete` → **Yes, delete everything** | Row, CV blob, events, matches gone — **verify in psql, not the chat** | |
| B13 | Send a scanned/image PDF | "I couldn't read much text…" + fallback button (graceful degradation) | |
| B14 ✅ | **No-CV path:** fresh `/start` → **No CV handy** | Role buttons → level → skills text → card → salary/remote → active | |
| B15 ✅ | Budget guard: `DAILY_LLM_BUDGET_CENTS=1` + run ingest/match | `llm_budget_exhausted` in logs; calls skipped, no crash, **no unreviewed alerts delivered** (fail-closed) | |

### Verification discipline (learned the hard way)

- **A `sent` row is only proof when the phone agrees.** The CLI once marked matches sent while printing `[would send]` — always confirm `match_cli_mode: telegram-delivery` in logs, zero `telegram_send_failed`, and the message on the device.
- Useful checks: `select * from llm_spend;` (budget accounting), `tier3_rejected` logs (reviewer reasoning), embedding coverage `count(*) filter (where embedding is not null)`.
- Tier-2 sanity for a subscriber: top candidates + sims via `1 - (j.embedding <=> s.profile_embedding)` ordered by `<=>` — related content lands ~0.4–0.6 with text-embedding-3-small; tier 2 ranks, tier 3 gates.

### Known behaviors / open items

- The reviewer occasionally returns `match: true` with a very low `fitScore` (a fit-8 alert was observed live). Feedback buttons are the countermeasure; a `fitScore` floor in the orchestrator is the candidate fix.
- First-run match quality depends on embedded-pool depth — `MAX_ENRICH_PER_RUN` (default 40/hour) drains the backlog over days; raise it temporarily to catch up (watch `DAILY_LLM_BUDGET_CENTS`).
- Unstated-salary rejections were a real failure mode; the prompt now forbids them — re-check occasionally that the calibration holds.

---

## Findings log — bugs found by live testing (all fixed)

| Date | Finding | Fix |
|---|---|---|
| 10-14 | `.dockerignore` excluded `drizzle/` — image couldn't ship migrations | removed from ignore |
| 10-14 | pgvector extension not enabled per-database — migrations crash-looped | `CREATE EXTENSION IF NOT EXISTS vector` at boot |
| 10-14 | healthz 404'd on query strings | pathname-only routing |
| 10-14 | `ingest_run` events lost (fire-and-forget insert raced pool close) | awaited |
| 10-14 | OpenAI strict mode rejects schemas with non-required properties | all-required review schema + strict LLM-facing profile schema |
| 10-14 | Tier-2 cutoff (0.62) starved tier-3 (similarities land 0.4–0.6) | tier 2 ranks top-K w/ 0.3 floor; tier 3 gates |
| 10-14 | Tier-3 failures swallowed silently | logged with provider error |
| 10-15 | `webhookCallback()` disables `bot.start()` as a side effect — polling could never boot | webhook handler built only in webhook mode |
| 10-15 | Stale webhook on token blocks polling | `deleteWebhook` before `bot.start()` |
| 10-15 | Duplicate welcomes (redelivery/double-tap); consent-first made `/start` non-idempotent | update-id LRU dedupe + 10s /start guard |
| 10-15 | Spent budget read as "broken" in the CV flow | honest budget-exhausted message + 5-question fallback |
| 10-15 | Conservative cost estimate let ~$0.10 of overnight enrichment consume the day's cap | `LLM_CENTS_PER_1K_TOKENS=0.2` documented/recommended |
| 10-15 | Aggregator reposts filled the whole top-5 with one real job | one candidate per company+title |
| 10-15 | Reviewer rejected postings for "salary not stated" | prompt: unstated ≠ rejection; like-currency comparison |
| 10-15 | **`match:once` CLI used the console notifier — rows marked sent, nothing delivered** | CLI delivers via the real bot when a token exists; logs its mode |
| 10-15 | Rationale addressed "the job seeker" — impersonal | prompt requires second-person "you" |
