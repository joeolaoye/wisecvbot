/**
 * Validate every board in boards.yaml against the live public ATS APIs —
 * no database, no keys. Dead boards print as FAIL (they'd land in dead_letters
 * during a real ingest). Run: npm run boards:check
 */
import { defaultBoardsPath, loadBoardsFromFile, type Board } from '../src/config/boards.js'
import { fetchAshby } from '../src/ingestion/ashby.js'
import { fetchGreenhouse } from '../src/ingestion/greenhouse.js'
import { fetchLever } from '../src/ingestion/lever.js'

const FETCHERS = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby }

async function main() {
  const boards = loadBoardsFromFile(defaultBoardsPath())
  const results = await Promise.allSettled(boards.map((b: Board) => FETCHERS[b.ats](b)))

  let ok = 0
  let failed = 0
  for (const [i, r] of results.entries()) {
    const b = boards[i]!
    if (r.status === 'fulfilled') {
      ok++
      console.log(`  OK   ${`${b.ats}:${b.token}`.padEnd(24)} ${r.value.length} jobs`)
    } else {
      failed++
      console.log(`  FAIL ${`${b.ats}:${b.token}`.padEnd(24)} ${String(r.reason).slice(0, 80)}`)
    }
  }
  console.log(`\n${ok} boards live, ${failed} dead (dead boards are skipped at ingest, not fatal)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
