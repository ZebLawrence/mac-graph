import { Hono } from 'hono'
import type { GraphStore } from '../../store/kuzu.js'
import type { Embedder } from '../../indexer/embed.js'
import type { WriteLock } from '../../lock.js'
import { readManifest } from '../../store/manifest.js'

export interface HealthDeps {
  startedAt: number
  store: GraphStore
  embedder: Embedder
  lock: WriteLock
  dataDir: string
}

export function healthRoutes(deps: HealthDeps): Hono {
  const app = new Hono()
  app.get('/health', async c => {
    const manifest = await readManifest(deps.dataDir)
    const lockState = deps.lock.inspect()

    // Use two separate queries to avoid kuzu v0.11 OPTIONAL MATCH + WITH chain quirks.
    // Both are wrapped in .catch() so a schema-not-ready error returns zeros.
    const [fileRows, symbolRows] = await Promise.all([
      deps.store.raw<{ files: bigint }>(
        `MATCH (f:File) RETURN count(f) AS files`
      ).catch(() => [{ files: 0n }]),
      deps.store.raw<{ symbols: bigint }>(
        `MATCH (s:Symbol) RETURN count(s) AS symbols`
      ).catch(() => [{ symbols: 0n }])
    ])

    return c.json({
      ok: true,
      uptimeMs: Date.now() - deps.startedAt,
      indexing: lockState.held,
      currentJob: lockState.holder,
      manifest,
      rowCounts: {
        files: Number(fileRows[0]?.files ?? 0),
        symbols: Number(symbolRows[0]?.symbols ?? 0)
      },
      embeddingModelLoaded: true  // set after embedder.ready() at startup
    })
  })
  return app
}
