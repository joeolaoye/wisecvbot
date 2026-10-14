import { checkConnection, closeDb } from '../storage/db.js'
import { runIngestion } from '../ingestion/index.js'
import { logger } from '../log.js'

/** One ingestion pass: fetch all boards → normalize → dedupe → upsert → enrich. */
async function main() {
  await checkConnection()
  const summary = await runIngestion()
  console.table(summary)
  await closeDb()
}

main().catch((err) => {
  logger.error('fatal', { error: String(err).slice(0, 500) })
  process.exit(1)
})
