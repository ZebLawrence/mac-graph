import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { GraphStore } from '../../src/store/kuzu.js'
import { FtsStore } from '../../src/store/fts.js'
import { Embedder } from '../../src/indexer/embed.js'
import { WriteLock } from '../../src/lock.js'
import { indexRoutes } from '../../src/http/routes/index-routes.js'

const FIX = join(__dirname, '../../fixtures/scip-tiny')

describe('POST /index', () => {
  let dataDir: string, app: Hono, store: GraphStore, fts: FtsStore

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-idx-'))
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    const embedder = new Embedder('Xenova/bge-small-en-v1.5')
    await embedder.ready()
    const lock = new WriteLock()
    app = new Hono().route('/', indexRoutes({
      repoDir: FIX, dataDir, store, fts, embedder, lock,
      embeddingModel: 'Xenova/bge-small-en-v1.5'
    }))
  }, 240_000)

  afterAll(async () => {
    await store.close(); fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('starts a job and reports completion via status', async () => {
    const start = await app.request('/index', { method: 'POST' })
    expect(start.status).toBe(202)
    const { jobId } = await start.json() as any
    expect(jobId).toBeTruthy()

    // poll
    let phase = ''
    for (let i = 0; i < 60; i++) {
      const r = await app.request(`/index/status/${jobId}`)
      const body = await r.json() as any
      phase = body.phase
      if (phase === 'complete' || phase === 'error') break
      await new Promise(r => setTimeout(r, 1000))
    }
    expect(phase).toBe('complete')
  }, 240_000)
})
