# Threat model (operator summary)

| Asset | Threat | Mitigation |
|---|---|---|
| CV / profile data | DB compromise, curious host admin | Envelope encryption at rest (key not in DB), logs without PII, `/delete` purge |
| CV / profile data | Third-party LLM provider retention | Structured profile (not raw CV) in prompts; use providers with no-training API terms; Ollama path for zero exfiltration |
| Subscribers | Malicious job postings (prompt injection, link injection, format injection) | Data-boundary prompt framing, no tools, schema-validated outputs, canonical-URL-only links, plain-text messages |
| Subscribers | Spam / unwanted automation | ≤3 alerts/day cap, consent gate, `/pause`, no outbound action without a user tap |
| Budget | Runaway LLM spend | Hard daily cap checked before every call; spend table; conservative cost accounting |
| Ingestion | Dead/renamed boards, upstream abuse | Per-board timeout + one retry, dead-letter table, boards never crash the run |
| Bot account | Token leak | Env-only storage; webhook secret; least-privilege DB roles |
| Availability | Restart mid-registration | In-flight conversation state is in-memory by design — user re-runs `/start`; confirmed data is DB-only |

Not in scope: multi-tenancy (single-tenant by design — each operator's data is physically separate), payments (v0.2+), portal auto-apply (deferred pending ToS review).
