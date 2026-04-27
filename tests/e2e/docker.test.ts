import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { waitHealthy, runContainer } from './helpers.js'

const FIX = join(__dirname, '../../fixtures/sample-app')

describe.skipIf(!process.env['E2E'])('docker e2e', () => {
  let container: Docker.Container
  let dataDir: string, wikiDir: string
  const port = 13030
  const base = `http://127.0.0.1:${port}`

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-e2e-d-'))
    wikiDir = mkdtempSync(join(tmpdir(), 'mg-e2e-w-'))
    container = await runContainer({
      image: 'mac-graph:latest', repoDir: FIX, dataDir, wikiDir, port
    })
    await waitHealthy(`${base}/health`)
  }, 240_000)

  afterAll(async () => {
    await container.stop().catch(() => {})
    await container.remove().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(wikiDir, { recursive: true, force: true })
  })

  it('GET /health returns ok', async () => {
    const r = await fetch(`${base}/health`)
    const body = await r.json() as any
    expect(body.ok).toBe(true)
  })

  it('POST /index runs to completion', async () => {
    const start = await fetch(`${base}/index`, { method: 'POST' })
    expect(start.status).toBe(202)
    const { jobId } = await start.json() as any
    let phase = ''
    for (let i = 0; i < 240; i++) {
      const r = await fetch(`${base}/index/status/${jobId}`)
      const body = await r.json() as any
      phase = body.phase
      if (phase === 'complete' || phase === 'error') break
      await new Promise(r => setTimeout(r, 1000))
    }
    expect(phase).toBe('complete')
  }, 240_000)

  it('MCP tools/list returns 5 tools', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    const body = await r.json() as any
    const names = body.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual(['context', 'detect_changes', 'impact', 'query', 'reindex'])
  })
})
