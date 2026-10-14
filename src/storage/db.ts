import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { env } from '../config/env.js'
import * as schema from './schema.js'

export const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 })
export const db = drizzle(pool, { schema })
export { schema }

export async function checkConnection(): Promise<void> {
  await pool.query('select 1')
}

export async function closeDb(): Promise<void> {
  await pool.end()
}
