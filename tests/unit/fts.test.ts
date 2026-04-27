import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FtsStore } from '../../src/store/fts.js'

describe('FtsStore', () => {
  let dir: string
  let fts: FtsStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mg-fts-'))
    fts = new FtsStore(join(dir, 'fts.db'))
  })
  afterEach(() => {
    fts.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('inserts and BM25-searches chunks', () => {
    fts.upsert('a:1-3', 'function fooBar() { return 42 }')
    fts.upsert('b:1-3', 'function bazQux() { return 99 }')
    const hits = fts.search('fooBar', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.id).toBe('a:1-3')
  })

  it('removes by id', () => {
    fts.upsert('x:1-1', 'hello world')
    fts.remove('x:1-1')
    expect(fts.search('hello', 5)).toEqual([])
  })

  it('removeByFile clears all chunks for a file', () => {
    fts.upsert('foo.ts:1-1', 'one')
    fts.upsert('foo.ts:5-5', 'two')
    fts.upsert('bar.ts:1-1', 'three')
    fts.removeByFile('foo.ts')
    expect(fts.search('one', 5)).toEqual([])
    expect(fts.search('two', 5)).toEqual([])
    expect(fts.search('three', 5).length).toBe(1)
  })
})
