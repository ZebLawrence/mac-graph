import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { GraphStore } from '../../src/store/kuzu.js'
import { FtsStore } from '../../src/store/fts.js'
import { Embedder } from '../../src/indexer/embed.js'
import { WriteLock } from '../../src/lock.js'
import { healthRoutes } from '../../src/http/routes/health.js'

describe('GET /health', () => {
  let dataDir: string
  let app: Hono
  let store: GraphStore
  let fts: FtsStore

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-h-'))
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    const embedder = new Embedder('Xenova/bge-small-en-v1.5')
    const lock = new WriteLock()
    app = new Hono().route('/', healthRoutes({
      startedAt: Date.now(), store, embedder, lock, dataDir
    }))
  }, 120_000)

  afterAll(async () => {
    await store.close(); fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('returns ok and includes uptime + manifest fields', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(typeof body.uptimeMs).toBe('number')
    expect(body.indexing).toBe(false)
  })
})
