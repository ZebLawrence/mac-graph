import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enumerateSources } from '../../src/indexer/enumerate.js'

describe('enumerateSources', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mg-e-'))
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1')
    writeFileSync(join(dir, 'src', 'b.css'), '.x { }')
    writeFileSync(join(dir, 'src', 'c.html'), '<div></div>')
    writeFileSync(join(dir, 'src', 'd.json'), '{}')
    writeFileSync(join(dir, 'src', 'e.bin'), 'binary')
    writeFileSync(join(dir, 'node_modules', 'react', 'i.ts'), 'export {}')
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns paths classified by language, ignoring gitignore', async () => {
    const out = await enumerateSources(dir)
    const paths = out.map(f => f.relPath).sort()
    expect(paths).toEqual(['src/a.ts', 'src/b.css', 'src/c.html', 'src/d.json', 'src/e.bin'])
    const byPath = Object.fromEntries(out.map(f => [f.relPath, f.language]))
    expect(byPath['src/a.ts']).toBe('ts')
    expect(byPath['src/b.css']).toBe('css')
    expect(byPath['src/e.bin']).toBe('other')
  })

  it('honors .mac-graph-ignore overlay', async () => {
    writeFileSync(join(dir, '.mac-graph-ignore'), 'src/e.bin\n')
    const out = await enumerateSources(dir)
    expect(out.find(f => f.relPath === 'src/e.bin')).toBeUndefined()
  })
})
