<p align="center"><img src="docs/images/logo.png" width="120" alt="WiseCV logo" /></p>

# WiseCV

**An open-source AI job-match agent you can run yourself.** WiseCV monitors public tech job boards hourly, matches new postings against each subscriber's confirmed profile, and delivers up to 3 fit-reviewed alerts a day via Telegram — each with *why it fits*, red flags, and one-tap CV tailoring (v0.2).

- **No scraping** — reads the official public JSON feeds of Greenhouse, Lever, and Ashby job boards, plus free aggregators
- **CV-first onboarding** — send your CV, the agent extracts your profile, **you ratify it** (that confirmation is the only thing matching ever reads)
- **Your data is yours** — CVs are envelope-encrypted at rest; `/delete` purges everything; no telemetry
- **Cheap by design** — three-tier matching (SQL filters → embeddings → LLM review) keeps LLM spend around $2–8/month, with a hard daily budget stop
- **Self-hostable in one command** — `docker compose up`

## Use the hosted bot

Message **@wisebot** on Telegram (the author's instance) — register in under 2 minutes: consent → CV → confirm → matches within 24h. *(Landing page: https://wisecv.example.com)*

## Run your own

Requirements: Docker, a Telegram bot token ([@BotFather](https://t.me/BotFather)), an OpenAI **or** Anthropic API key (chat + reviews run on either — `LLM_PROVIDER`; embeddings use the OpenAI-compatible provider, or [Ollama](https://ollama.com) for fully-local), a Postgres with the pgvector extension (compose provides one).

```bash
git clone https://github.com/joeolaoye/wisecvbot && cd wisecvbot
cp .env.example .env        # fill in TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, CV_ENCRYPTION_KEY
docker compose -f deploy/docker-compose.yml up -d --build
```

Migrations apply automatically at boot. Without `APP_URL` set the bot runs in long-polling mode — perfect for local testing. Full guide: [docs/self-hosting.md](docs/self-hosting.md).

## Production deployment

Merges to `main` run the verification suite and deploy the exact commit to the production EC2 host through AWS Systems Manager. GitHub authenticates with OIDC, so the repository does not store long-lived AWS access keys. The deploy script health-checks the new container and restores the previous image if startup fails.

## How it works

```
ATS public APIs (40+ boards) ─► hourly ingest ─► normalize · dedupe · classify · embed
                                                                        │
                                     Postgres + pgvector ◄──────────────┘
                                                                        │
subscriber's ratified profile ─► tier 1: SQL filters ─► tier 2: embedding rank
                                                                        │
                          tier 3: LLM fit review (budget-capped) ─► ≤3 alerts/day
                                                                        │
                                    Telegram ◄── feedback buttons tune future matches
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · security model: [docs/threat-model.md](docs/threat-model.md)

## Contribute

The easiest meaningful PR in open source — add a company's job board as one line of YAML:

```yaml
- { company: Acme, ats: greenhouse, token: acme }
```

Verify with `npm run boards:check`, open the PR, done. See [CONTRIBUTING.md](docs/CONTRIBUTING.md). The codebase is deliberately boring and legible (strict TypeScript, tested, no framework magic) — it doubles as a learning project for engineers early in their careers. Good first issues are labeled.

## Develop

```bash
npm install
npm test          # 67 tests, no network, no database needed
npm run lint && npm run typecheck
npm run ingest:once   # one live ingest pass (needs DATABASE_URL)
```

## License

AGPL-3.0 — see [LICENSE](LICENSE). Run it, fork it, learn from it; if you offer it as a hosted service, publish your modifications.
