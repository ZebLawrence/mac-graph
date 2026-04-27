import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { ReindexInput } from '../schemas.js'
import { runFullIndex, runIncrementalIndex } from '../../indexer/orchestrator.js'
import { log } from '../../log.js'
import type { McpDeps } from '../server.js'

export function registerReindexTool(mcp: McpServer, deps: McpDeps): void {
  mcp.tool(
    'reindex',
    'Trigger a reindex run from inside a session. Returns immediately; poll /index/status/:job_id for progress.',
    {
      mode: z.enum(['full', 'incremental']).optional().describe('Index mode (default: incremental)'),
      paths: z.array(z.string()).optional().describe('Paths to reindex (required when mode=incremental)'),
    },
    async (args) => {
      const parsed = ReindexInput.parse(args as unknown)
      const { mode = 'incremental', paths } = parsed

      // Probe the lock — if already held, return busy immediately
      const probe = deps.lock.tryAcquire('pending')
      if (probe === null) {
        const result = {
          status: 'busy',
          job_id: deps.lock.inspect().holder,
          estimate_ms: 0,
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        }
      }

      // Release probe, then kick off async work
      probe()
      const id = 'ix_' + randomUUID()

      const job = {
        repoDir: deps.repoDir,
        dataDir: deps.dataDir,
        store: deps.store,
        fts: deps.fts,
        embeddingModel: deps.embeddingModel,
      }

      // IIFE — runs in background after we return
      ;(async () => {
        const release = await deps.lock.acquire(id)
        try {
          if (mode === 'full') {
            await runFullIndex(job)
          } else {
            await runIncrementalIndex(job, paths ?? [])
          }
        } catch (err) {
          log.error({ err, job_id: id }, 'reindex failed')
        } finally {
          release()
        }
      })()

      const result = {
        status: 'started',
        job_id: id,
        estimate_ms: mode === 'full' ? 60_000 : 5_000,
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      }
    },
  )
}
