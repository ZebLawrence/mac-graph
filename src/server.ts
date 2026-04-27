import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { env } from './env.js'
import { log } from './log.js'
import { GraphStore } from './store/kuzu.js'
import { FtsStore } from './store/fts.js'
import { Embedder } from './indexer/embed.js'
import { WriteLock } from './lock.js'
import { healthRoutes } from './http/routes/health.js'
import { indexRoutes } from './http/routes/index-routes.js'

export async function start(): Promise<void> {
  const startedAt = Date.now()
  log.info({ env: { port: env.PORT, dataDir: env.DATA_DIR, repoDir: env.REPO_DIR } }, 'starting mac-graph')

  const store = await GraphStore.open(join(env.DATA_DIR, 'kuzu'))
  const fts = new FtsStore(join(env.DATA_DIR, 'fts.db'))
  const embedder = new Embedder(env.EMBEDDING_MODEL)
  await embedder.ready()
  const lock = new WriteLock()

  const app = new Hono()
  app.route('/', healthRoutes({ startedAt, store, embedder, lock, dataDir: env.DATA_DIR }))
  app.route('/', indexRoutes({
    repoDir: env.REPO_DIR, dataDir: env.DATA_DIR,
    store, fts, embedder, lock,
    embeddingModel: env.EMBEDDING_MODEL
  }))

  const hostname = env.BIND_ALL ? '0.0.0.0' : '127.0.0.1'
  const server = serve({ fetch: app.fetch, hostname, port: env.PORT })
  log.info({ hostname, port: env.PORT }, 'mac-graph listening')

  process.on('SIGTERM', async () => {
    log.info('SIGTERM — shutting down')
    server.close()
    await store.close()
    fts.close()
    process.exit(0)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch(err => { log.fatal(err); process.exit(1) })
}
