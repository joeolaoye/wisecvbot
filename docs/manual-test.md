# WiseCV — Manual Test Cases

Two tracks: **A** runs entirely local in Docker with zero external credentials (headless mode — proves the pipeline); **B** is the full user journey with a real bot (proves the product).

---

## Track A — Local Docker, no credentials required (~10 minutes)

> What this proves: image builds, migrations apply at boot, 40 boards ingest live, the API surface behaves, the match engine runs against a seeded subscriber.

### A1. Bring the stack up

```bash
cp .env.example .env                     # then set CV_ENCRYPTION_KEY (openssl rand -base64 32)
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up -d --build
```

**Pass criteria:**
- [ ] `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml ps` → `db` healthy, `app` running
- [ ] App logs contain `migrations_applied`, `headless_mode`, `scheduler_started`, `server_listening`:
  `docker compose -f deploy/docker-compose.yml logs app | head -20`
- [ ] No TELEGRAM_BOT_TOKEN was set — this is headless mode working as designed

### A2. Health endpoint

```bash
curl -s http://localhost:3000/healthz | jq
```

**Pass criteria:**
- [ ] HTTP 200, JSON `{"ok":true,"jobs":0,"deadLetters":0}` (jobs count 0 before first ingest)
- [ ] `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/nope` → `404`

### A3. Live ingestion (40 boards, real data)

```bash
docker compose -f deploy/docker-compose.yml exec app node dist/cli/ingest.js
```

**Pass criteria:**
- [ ] Summary table shows `sourcesOk` ≥ 35 (a few dead boards land in deadLetters — by design)
- [ ] `jobsNew` in the thousands on first run
- [ ] Postgres agrees:
  ```bash
  docker compose -f deploy/docker-compose.yml exec db psql -U wisecv -c \
    "select count(*) as jobs, count(distinct company) as companies, count(*) filter (where remote) as remote from jobs;"
  docker compose -f deploy/docker-compose.yml exec db psql -U wisecv -c \
    "select role_family, seniority, count(*) from jobs group by 1,2 order by 3 desc limit 10;"
  ```
- [ ] `curl -s http://localhost:3000/healthz | jq .jobs` now shows the row count
- [ ] No PII-shaped content anywhere in `logs app`

### A4. Match engine against a seeded subscriber

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
- [ ] Summary shows `subscribersConsidered: 1` and the run completes without error
- [ ] `alertsSent: 0` is EXPECTED here: without an `OPENAI_API_KEY` there are no embeddings, and post-review the engine deliberately delivers nothing on tier-2 evidence alone (fail-closed, not spam)
- [ ] With an API key set in `.env` (then `up -d` again + rerun A3/A4): tier-2 + tier-3 activate, and the subscriber receives matches:
  ```bash
  docker compose -f deploy/docker-compose.yml exec db psql -U wisecv -c \
    "select m.status, j.company, j.title, m.fit_score from matches m join jobs j on j.id=m.job_id limit 5;"
  ```

### A5. Restart resilience (the pending/sent fix)

```bash
docker compose -f deploy/docker-compose.yml restart app
curl -s http://localhost:3000/healthz   # still healthy, data intact
```

**Pass criteria:** [ ] job count unchanged after restart; app logs show migrations skip (already applied).

---

## Track B — Full user journey with a real bot (needs BotFather token + API key)

**Setup:** `.env` with `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`; `docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.local.yml up -d --build`.

| # | Step | Expected result | ✓ |
|---|------|-----------------|---|
| B1 | Message the bot `/start` | Welcome + privacy copy, `Agree & continue` / `No thanks` buttons. No data stored yet (check `subscribers` table stays empty) | |
| B2 | Tap **No thanks** | "everything is already deleted" — row count still 0 | |
| B3 | `/start` → tap **Agree & continue** | "Send me your CV — PDF or Word" with the no-CV fallback button; a `subscribers` row now exists with `consent_at` set | |
| B4 | Send a PDF/DOCX CV | "Reading your CV… 📖" → confirmation card: role, skills, domains, location; `⚠️` on uncertain fields. `cv_blob` is binary (encrypted), not readable text | |
| B5 | Tap **✏️ Edit**, send `seniority: staff` + `skills: +Rust -PHP` | Card re-renders with edits applied | |
| B6 | Tap **✅ Looks right** → salary button → remote button | "You're set ✅…" — `status: active`, `profile_embedding` populated | |
| B7 | Wait ≤24h (or `exec app node dist/cli/match.js`) | ≤3 match messages, each: why-it-fits bullets referencing YOUR skills, flags, and the canonical `🔗` job URL — never any other link | |
| B8 | Tap **🙅 Not for me** | "Noted — fewer like this"; `match_threshold` nudged up in DB | |
| B9 | Tap **🔀 Wrong direction** → pick a reason | "profile updated" — reason appended to profile notes | |
| B10 | `/profile` | Current card + edit instructions | |
| B11 | `/pause` → `/resume` | Status flips in DB both times | |
| B12 | `/delete` → **Yes, delete everything** | Row, CV blob, events, matches all gone — **verify in psql, not the chat** | |
| B13 | Send a scanned/image PDF | "I couldn't read much text…" + fallback button (graceful degradation) | |
| B14 | No-CV path: `/start` fresh → **No CV handy** | 5 quick questions → same confirmation card | |
| B15 | Budget guard: set `DAILY_LLM_BUDGET_CENTS=1`, run ingest + match | Calls skipped with `llm_budget_exhausted` in logs; no crash; no unreviewed alerts delivered | |

**Invariant spot-checks while B runs:**
- [ ] `select * from events order by id desc limit 10;` — IDs and field names only, no CV/profile values
- [ ] `grep -i 'parse_mode' -r dist/` → nothing
- [ ] Every URL in any delivered message equals the `jobs.url` of its match row
