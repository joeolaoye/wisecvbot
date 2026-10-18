# Self-hosting WiseCV

## Quickstart

```bash
cp .env.example .env   # fill in the required values (below)
docker compose -f deploy/docker-compose.yml up -d --build
```

The compose stack runs three services: the app, Postgres 16 with pgvector, and Caddy (automatic TLS). Point your domain's DNS at the host and set `APP_DOMAIN` + `APP_URL`. **Migrations apply automatically at boot** (the pgvector extension is enabled too) — no manual step. On an external database, make sure the `vector` extension is available to your user; the app runs `CREATE EXTENSION IF NOT EXISTS vector` first.

## Required environment

| Variable                  | Notes                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | Compose provides `postgres://wisecv:wisecv@db:5432/wisecv`                                                 |
| `TELEGRAM_BOT_TOKEN`      | Create a bot with [@BotFather](https://t.me/BotFather)                                                     |
| `CV_ENCRYPTION_KEY`       | `openssl rand -base64 32` — **back this up**; CVs are undecryptable without it                             |
| `OPENAI_API_KEY`          | Chat when `LLM_PROVIDER=openai` (the default), and **always** embeddings — Anthropic has no embeddings API |
| `ANTHROPIC_API_KEY`       | Chat when `LLM_PROVIDER=anthropic` (Claude)                                                                |
| `TELEGRAM_WEBHOOK_SECRET` | **Required when `APP_URL` is set** (webhook mode refuses to boot without it) — `openssl rand -hex 32`      |
| `APP_URL`                 | Your public HTTPS URL — sets webhook mode. Omit for long-polling (dev)                                     |

Optional: `LLM_PROVIDER` (`openai` default | `anthropic`), `CHAT_MODEL` (overrides the provider default: gpt-4o-mini / claude-haiku-4-5), `ADZUNA_APP_ID/KEY` (aggregator coverage), `DAILY_LLM_BUDGET_CENTS` (default 500), `LLM_MATCH_RESERVE_CENTS` (default 10; held back from background enrichment for profile matching and alerts), `LLM_CENTS_PER_1K_TOKENS` (budget cost estimate — the default 1¢/1k over-estimates gpt-4o-mini ~20×, which drains the nominal budget early on the safe side; set 0.2 for tighter accounting), `MAX_MATCH_ALERTS_PER_DAY` (default 3), `EMBEDDING_MODEL` (default text-embedding-3-small), `POSTHOG_API_KEY`/`POSTHOG_HOST` (product analytics — **fully off without a key**; when on, it's pseudonymous event counts only, with a subscriber-facing `/analytics` opt-out).

**Ollama note:** set `OPENAI_BASE_URL` to your Ollama endpoint for fully-local — it serves both chat (as the openai-compatible provider) and embeddings. Embeddings must be 1536-dimension to match the schema (e.g. nomic-embed-text with a dims migration); simplest local path: run chat on Ollama and keep a hosted embeddings key.

## Operating

- Ingest runs hourly, match runs daily at 09:30 UTC (configurable via `INGEST_CRON`/`MATCH_CRON`)
- `npm run boards:check` — validate your boards list against live APIs
- `GET /healthz` — liveness + job count; wire to uptime monitoring
- **Backups:** `pg_dump wisecv | age -r <your-key> > backup.sql.age` nightly offsite. Test a restore once. CV blobs live in the DB, so the backup _is_ the CV archive.
- **Upgrade:** `git pull && docker compose -f deploy/docker-compose.yml up -d --build && … exec app npm run db:migrate`

## Hardening checklist

- [ ] Firewall: only 80/443 exposed; SSH by key only
- [ ] Encrypted volume / full-disk encryption on the host
- [ ] `CV_ENCRYPTION_KEY` and bot token stored in a secret manager, not chat/notes
- [ ] Restore tested at least once
