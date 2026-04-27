import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/store/kuzu.js'

describe('GraphStore', () => {
  let dir: string
  let store: GraphStore
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mg-'))
    store = await GraphStore.open(join(dir, 'kuzu'))
  })
  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('inserts and retrieves a File node', async () => {
    await store.upsertFile({
      path: 'src/foo.ts', language: 'ts', sha: 'abc',
      sizeBytes: 100n, loc: 10
    })
    const got = await store.getFile('src/foo.ts')
    expect(got?.path).toBe('src/foo.ts')
    expect(got?.sha).toBe('abc')
  })

  it('inserts a Symbol and CONTAINS edge', async () => {
    await store.upsertFile({ path: 'a.ts', language: 'ts', sha: 's', sizeBytes: 0n, loc: 0 })
    await store.upsertSymbol({
      id: 'sym1', name: 'foo', kind: 'function', language: 'ts',
      filePath: 'a.ts', startLine: 1, startCol: 0, endLine: 5, endCol: 0,
      signature: '', doc: '', clusterId: ''
    })
    await store.linkContains('a.ts', 'sym1')
    const syms = await store.symbolsInFile('a.ts')
    expect(syms.map(s => s.id)).toContain('sym1')
  })

  it('truncates all tables', async () => {
    await store.upsertFile({ path: 'a.ts', language: 'ts', sha: 's', sizeBytes: 0n, loc: 0 })
    await store.truncateAll()
    expect(await store.getFile('a.ts')).toBeNull()
  })
})
