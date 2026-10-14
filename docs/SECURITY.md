# Security policy

## Reporting a vulnerability

Email **security@wisecv.example.com** (replace with your instance's contact). Please do not open public issues for vulnerabilities. We aim to respond within 72 hours and will credit reporters unless anonymity is requested.

## What the software protects (in scope)

- **Subscriber PII:** CVs are AES-256-GCM envelope-encrypted at rest (key from env, never in the DB); matching uses the ratified structured profile, never the raw CV; logs carry IDs only; `/delete` purges CV, profile, and cascades events/matches.
- **Untrusted content:** job descriptions and CVs are attacker-controllable text. They enter prompts only inside `UNTRUSTED-DATA` boundaries under a no-tools system prompt; LLM outputs are schema-validated and discarded on any anomaly; links shown to users come only from the ATS record's canonical URL; messages are plain text (no parse_mode) so postings cannot inject formatting or links.
- **Credentials:** all secrets from the environment; webhook verified by shared secret; no admin surface in v1.
- **Spend:** hard daily LLM budget gate checked before every call.

## What the operator owns (out of scope for the code)

Host access, firewall, encrypted volumes, secret custody, backups and restore drills, and keeping `CV_ENCRYPTION_KEY` safe (lost key = CVs are cryptographically gone — by design). See [self-hosting.md](self-hosting.md#hardening-checklist) and [threat-model.md](threat-model.md).
