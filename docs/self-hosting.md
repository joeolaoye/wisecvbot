# Self-hosting WiseCV

## Quickstart

```bash
cp .env.example .env   # fill in the required values (below)
docker compose -f deploy/docker-compose.yml up -d --build
```

The compose stack runs three services: the app, Postgres 16 with pgvector, and Caddy (automatic TLS). Point your domain's DNS at the host and set `APP_DOMAIN` + `APP_URL`. **Migrations apply automatically at boot** (the pgvector extension is enabled too) — no manual step. On an external database, make sure the `vector` extension is available to your user; the app runs `CREATE EXTENSION IF NOT EXISTS vector` first.

## Required environment

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Compose provides `postgres://wisecv:wisecv@db:5432/wisecv` |
| `TELEGRAM_BOT_TOKEN` | Create a bot with [@BotFather](https://t.me/BotFather) |
| `CV_ENCRYPTION_KEY` | `openssl rand -base64 32` — **back this up**; CVs are undecryptable without it |
| `OPENAI_API_KEY` | Any OpenAI-compatible provider; or set `OPENAI_BASE_URL` to an Ollama endpoint for fully-local |
| `TELEGRAM_WEBHOOK_SECRET` | **Required when `APP_URL` is set** (webhook mode refuses to boot without it) — `openssl rand -hex 32` |
| `APP_URL` | Your public HTTPS URL — sets webhook mode. Omit for long-polling (dev) |

Optional: `ADZUNA_APP_ID/KEY` (aggregator coverage), `DAILY_LLM_BUDGET_CENTS` (default 500), `LLM_CENTS_PER_1K_TOKENS` (budget cost estimate — the default 1¢/1k over-estimates gpt-4o-mini ~20×, which drains the nominal budget early on the safe side; set 0.2 for tighter accounting), `MAX_MATCH_ALERTS_PER_DAY` (default 3), `CHAT_MODEL`/`EMBEDDING_MODEL` (defaults: gpt-4o-mini / text-embedding-3-small).

**Ollama note:** embeddings require a 1536-dimension model to match the schema (e.g. a re-embedding migration, or use nomic-embed-text with a dims migration). Simplest local path: keep a hosted embedding key and run only the chat model locally.

## Operating

- Ingest runs hourly, match runs daily at 09:00 (configurable via `INGEST_CRON`/`MATCH_CRON`)
- `npm run boards:check` — validate your boards list against live APIs
- `GET /healthz` — liveness + job count; wire to uptime monitoring
- **Backups:** `pg_dump wisecv | age -r <your-key> > backup.sql.age` nightly offsite. Test a restore once. CV blobs live in the DB, so the backup *is* the CV archive.
- **Upgrade:** `git pull && docker compose -f deploy/docker-compose.yml up -d --build && … exec app npm run db:migrate`

## Hardening checklist

- [ ] Firewall: only 80/443 exposed; SSH by key only
- [ ] Encrypted volume / full-disk encryption on the host
- [ ] `CV_ENCRYPTION_KEY` and bot token stored in a secret manager, not chat/notes
- [ ] Restore tested at least once
