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

const FIX = join(__dirname, '../../fixtures/scip-tiny')

describe('MCP tools', () => {
  let dataDir: string, store: GraphStore, fts: FtsStore, app: Awaited<ReturnType<typeof buildMcpApp>>

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-mcp-'))
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    const embedder = new Embedder('Xenova/bge-small-en-v1.5')
    await embedder.ready()
    const lock = new WriteLock()
    await runFullIndex({
      repoDir: FIX, dataDir, store, fts,
      embeddingModel: 'Xenova/bge-small-en-v1.5',
    })
    app = await buildMcpApp({
      store, fts, embedder, lock,
      repoDir: FIX, dataDir,
      embeddingModel: 'Xenova/bge-small-en-v1.5',
    })
  }, 240_000)

  afterAll(async () => {
    await store.close(); fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('lists query among tools', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { tools: Array<{ name: string }> } }
    const names = body.result.tools.map(t => t.name)
    expect(names).toContain('query')
  })

  it('runs query and returns hits', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2,
        method: 'tools/call',
        params: { name: 'query', arguments: { q: 'greet' } },
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { content: Array<{ type: string; text: string }> } }
    const payload = JSON.parse(body.result.content[0]!.text) as { results: Array<{ name: string }> }
    expect(payload.results.some(r => r.name === 'greet')).toBe(true)
  })

  it('context returns callers and callees for shout', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3,
        method: 'tools/call',
        params: { name: 'context', arguments: { name: 'shout' } }
      })
    })
    const body = await res.json() as any
    const payload = JSON.parse(body.result.content[0].text)
    expect(payload.symbol?.name).toBe('shout')
    expect(payload.callees.some((c: any) => c.symbol.name === 'greet')).toBe(true)
  })
})
