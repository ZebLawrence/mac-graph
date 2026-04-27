import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/store/kuzu.js'
import { FtsStore } from '../../src/store/fts.js'
import { Embedder } from '../../src/indexer/embed.js'
import { runFullIndex } from '../../src/indexer/orchestrator.js'
import { runQuery } from '../../src/search/query.js'

const FIX = join(__dirname, '../../fixtures/scip-tiny')

describe('runQuery', () => {
  let dataDir: string
  let store: GraphStore
  let fts: FtsStore
  let embedder: Embedder

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-q-'))
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    embedder = new Embedder('Xenova/bge-small-en-v1.5')
    await runFullIndex({
      repoDir: FIX, dataDir, store, fts,
      embeddingModel: 'Xenova/bge-small-en-v1.5'
    })
  }, 240_000)

  afterAll(async () => {
    await store.close(); fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('finds greet by name', async () => {
    const hits = await runQuery({ store, fts, embedder }, { q: 'greet' })
    expect(hits.some(h => h.name === 'greet')).toBe(true)
  })
})
