import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { problem } from '../errors.js'
import { runFullIndex, runIncrementalIndex } from '../../indexer/orchestrator.js'
import type { GraphStore } from '../../store/kuzu.js'
import type { FtsStore } from '../../store/fts.js'
import type { Embedder } from '../../indexer/embed.js'
import type { WriteLock } from '../../lock.js'
import { log } from '../../log.js'

export interface IndexRoutesDeps {
  repoDir: string
  dataDir: string
  store: GraphStore
  fts: FtsStore
  embedder: Embedder
  lock: WriteLock
  embeddingModel: string
}

interface JobState {
  id: string
  startedAt: number
  endedAt?: number
  phase: 'queued' | 'running' | 'complete' | 'error'
  error?: string
}

export function indexRoutes(deps: IndexRoutesDeps): Hono {
  const app = new Hono()
  const jobs = new Map<string, JobState>()

  async function startJob(mode: 'full' | 'incremental', changedPaths?: string[]): Promise<JobState | { busy: true; holder: string }> {
    const tryRelease = deps.lock.tryAcquire('pending')
    if (!tryRelease) {
      return { busy: true, holder: deps.lock.inspect().holder ?? 'unknown' }
    }
    tryRelease()  // release the placeholder; the actual job re-acquires below

    const id = `ix_${randomUUID()}`
    const state: JobState = { id, startedAt: Date.now(), phase: 'queued' }
    jobs.set(id, state)

    ;(async () => {
      const release = await deps.lock.acquire(id)
      try {
        state.phase = 'running'
        const job = {
          repoDir: deps.repoDir, dataDir: deps.dataDir,
          store: deps.store, fts: deps.fts,
          embeddingModel: deps.embeddingModel
        }
        if (mode === 'full') {
          await runFullIndex(job)
        } else {
          await runIncrementalIndex(job, changedPaths ?? [])
        }
        state.phase = 'complete'
      } catch (err) {
        state.phase = 'error'
        state.error = (err as Error).message
        log.error({ err, jobId: id }, 'index job failed')
      } finally {
        state.endedAt = Date.now()
        release()
      }
    })()

    return state
  }

  app.post('/index', async c => {
    const r = await startJob('full')
    if ('busy' in r) {
      return problem(c, 409, 'index-busy', 'Index job in flight', `Job ${r.holder} is currently running`, { jobId: r.holder })
    }
    return c.json({ jobId: r.id, phase: r.phase, startedAt: r.startedAt }, 202 as 202)
  })

  app.post('/index/incremental', async c => {
    const body = await c.req.json().catch(() => ({})) as { changedPaths?: string[] }
    if (!Array.isArray(body.changedPaths) || body.changedPaths.length === 0) {
      return problem(c, 400, 'invalid-input', 'changedPaths required', 'Body must include a non-empty changedPaths string array')
    }
    const r = await startJob('incremental', body.changedPaths)
    if ('busy' in r) {
      return problem(c, 409, 'index-busy', 'Index job in flight', `Job ${r.holder} is currently running`, { jobId: r.holder })
    }
    return c.json({ jobId: r.id, phase: r.phase }, 202 as 202)
  })

  app.get('/index/status/:jobId', c => {
    const id = c.req.param('jobId')
    const job = jobs.get(id)
    if (!job) return problem(c, 404, 'job-not-found', 'No such job', `Job ${id} not found`)
    return c.json({
      jobId: job.id, phase: job.phase,
      startedAt: job.startedAt, endedAt: job.endedAt,
      error: job.error
    })
  })

  return app
}
