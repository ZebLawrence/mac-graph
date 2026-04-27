import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/store/kuzu.js'
import { FtsStore } from '../../src/store/fts.js'
import { Embedder } from '../../src/indexer/embed.js'
import { WriteLock } from '../../src/lock.js'
import { runFullIndex } from '../../src/indexer/orchestrator.js'
import { buildMcpApp } from '../../src/mcp/server.js'

const FIX = join(__dirname, '../../fixtures/sample-app')

async function callTool(app: any, name: string, args: unknown, id = 1) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  })
  const body = await res.json() as any
  return JSON.parse(body.result.content[0].text)
}

describe('sample-app integration', () => {
  let dataDir: string, store: GraphStore, fts: FtsStore, app: any

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-sample-'))
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    const embedder = new Embedder('Xenova/bge-small-en-v1.5')
    await embedder.ready()
    const lock = new WriteLock()
    await runFullIndex({ repoDir: FIX, dataDir, store, fts, embeddingModel: 'Xenova/bge-small-en-v1.5' })
    app = await buildMcpApp({ store, fts, embedder, lock, repoDir: FIX, dataDir, embeddingModel: 'Xenova/bge-small-en-v1.5' })
  }, 240_000)

  afterAll(async () => {
    await store.close(); fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('indexes TS, HTML, CSS, JSON', async () => {
    const all = await store.raw<{ path: string; language: string }>(
      `MATCH (f:File) RETURN f.path AS path, f.language AS language`)
    const byLang = all.reduce((m, r) => ({ ...m, [r.language]: (m[r.language] ?? 0) + 1 }), {} as Record<string, number>)
    expect(byLang.ts).toBeGreaterThanOrEqual(3)
    expect(byLang.html).toBeGreaterThanOrEqual(1)
    expect(byLang.css).toBeGreaterThanOrEqual(1)
    expect(byLang.json).toBeGreaterThanOrEqual(1)
  })

  it('impact on login surfaces handle and authenticate as transitive callers, plus tests/auth.test.ts', async () => {
    const ctx = await callTool(app, 'context', { name: 'login' })
    const id = ctx.symbol.id
    const imp = await callTool(app, 'impact', { symbol_id: id, hops: 3 })
    const callerNames = imp.transitive_callers.map((c: any) => c.symbol.name)
    expect(callerNames).toEqual(expect.arrayContaining(['authenticate', 'handle']))
    expect(imp.tests_affected).toContain('tests/auth.test.ts')
  })

  it('query finds login by free text', async () => {
    const r = await callTool(app, 'query', { q: 'authentication login' })
    expect(r.results.some((h: any) => h.name === 'login')).toBe(true)
  })

  it('finds CSS class symbol', async () => {
    const rows = await store.raw<{ s: any }>(
      `MATCH (s:Symbol {name: '.btn-primary'}) RETURN s`)
    expect(rows.length).toBeGreaterThan(0)
  })
})
