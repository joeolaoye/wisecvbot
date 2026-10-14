import { env } from './config/env.js'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
type Level = keyof typeof LEVELS

function log(level: Level, msg: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[env.LOG_LEVEL]) return
  const line = { ts: new Date().toISOString(), level, msg, ...data }
  // IDs and counters only — never subscriber content (architecture §8)
  process.stdout.write(JSON.stringify(line) + '\n')
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
}
