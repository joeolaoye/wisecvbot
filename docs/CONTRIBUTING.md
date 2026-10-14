# Contributing

Thanks for helping! The codebase is deliberately boring and legible — strict TypeScript, small modules, tests for every rule. If you're early in your engineering career, this repo is meant for you: every module maps to one idea, and the tests show how each piece behaves.

## The one-line PR: add a job board

1. Find a company's careers page. If it's hosted by Greenhouse, Lever, or Ashby, its postings are a public JSON feed.
2. Add one line to `src/config/boards.yaml`:
   ```yaml
   - { company: Acme, ats: greenhouse, token: acme }
   ```
3. Verify: `npm run boards:check` (no database needed). You should see `OK greenhouse:acme  N jobs`.
4. Open the PR.

## Everything else

```bash
npm install
npm test          # must pass, no network or DB required
npm run lint && npm run typecheck
```

- Keep modules small and single-purpose; match the existing style.
- New rules (salary parsing, role classification, filters) come with tests — see `tests/pipeline/` for examples.
- New job sources implement the adapter pattern in `src/ingestion/` with a recorded-fixture test.
- CI must be green; PRs run lint + typecheck + tests.

## Reporting issues

Include what you expected, what happened, and how to reproduce. For security issues see [SECURITY.md](SECURITY.md) — never public issues.
