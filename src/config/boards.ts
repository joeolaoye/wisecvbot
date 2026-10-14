import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { parse } from 'yaml'

export const ATS_NAMES = ['greenhouse', 'lever', 'ashby'] as const
export type AtsName = (typeof ATS_NAMES)[number]

const boardSchema = z.object({
  company: z.string().min(1),
  ats: z.enum(ATS_NAMES),
  token: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'ATS token must be a lowercase slug'),
})

export type Board = z.infer<typeof boardSchema>

const boardsFileSchema = z.object({ boards: z.array(boardSchema).min(1) })

/** Parse + validate boards.yaml. Duplicate tokens are rejected — two entries for one board is a config bug. */
export function loadBoards(yamlText: string): Board[] {
  const raw = parse(yamlText)
  const parsed = boardsFileSchema.parse(raw)
  const seen = new Set<string>()
  for (const b of parsed.boards) {
    const key = `${b.ats}:${b.token}`
    if (seen.has(key)) throw new Error(`Duplicate board in boards.yaml: ${key}`)
    seen.add(key)
  }
  return parsed.boards
}

export function loadBoardsFromFile(path: string): Board[] {
  return loadBoards(readFileSync(path, 'utf8'))
}

export function defaultBoardsPath(): string {
  return new URL('./boards.yaml', import.meta.url).pathname
}
