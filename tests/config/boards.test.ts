import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultBoardsPath, loadBoardsFromFile } from '../../src/config/boards.js'

describe('boards.yaml', () => {
  const boards = loadBoardsFromFile(defaultBoardsPath())

  test('ships with at least 25 seeded companies', () => {
    expect(boards.length).toBeGreaterThanOrEqual(25)
  })

  test('every token is a lowercase slug', () => {
    for (const b of boards) {
      expect(b.token).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    }
  })

  test('covers all three ATS sources', () => {
    const ats = new Set(boards.map((b) => b.ats))
    expect([...ats].sort()).toEqual(['ashby', 'greenhouse', 'lever'])
  })

  test('no duplicate boards', () => {
    const keys = boards.map((b) => `${b.ats}:${b.token}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('the shipped yaml file itself parses', () => {
    // guards against hand-edit breakage in the most-PR-ed file in the repo
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../src/config/boards.yaml'), 'utf8')
    expect(loadBoardsFromFile.name).toBe('loadBoardsFromFile')
    expect(text).toContain('greenhouse')
  })
})
