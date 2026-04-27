import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFullIndex } from '../../src/indexer/orchestrator.js'
import { GraphStore } from '../../src/store/kuzu.js'
import { FtsStore } from '../../src/store/fts.js'

const FIX = join(__dirname, '../../fixtures/scip-tiny')

describe('runFullIndex', () => {
  let dataDir: string
  let store: GraphStore
  let fts: FtsStore

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-orch-'))
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    await runFullIndex({
      repoDir: FIX, dataDir, store, fts,
      embeddingModel: 'Xenova/bge-small-en-v1.5'
    })
  }, 240_000)

  afterAll(async () => {
    await store.close()
    fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('writes File and Symbol nodes', async () => {
    expect((await store.getFile('a.ts'))?.path).toBe('a.ts')
    const syms = await store.symbolsInFile('a.ts')
    expect(syms.map(s => s.name)).toEqual(expect.arrayContaining(['greet', 'shout']))
  })

  it('writes a manifest', async () => {
    const { readManifest } = await import('../../src/store/manifest.js')
    const m = await readManifest(dataDir)
    expect(m).not.toBeNull()
    expect(m!.fileCount).toBeGreaterThan(0)
    expect(m!.symbolCount).toBeGreaterThan(0)
  })

  it('FTS contains chunk text', () => {
    const hits = fts.search('greet', 5)
    expect(hits.length).toBeGreaterThan(0)
  })
})
