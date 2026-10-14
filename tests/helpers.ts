import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const testDir = dirname(fileURLToPath(import.meta.url))
