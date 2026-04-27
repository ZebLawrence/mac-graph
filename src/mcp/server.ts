import { Hono } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { GraphStore } from '../store/kuzu.js'
import type { FtsStore } from '../store/fts.js'
import type { Embedder } from '../indexer/embed.js'
import type { WriteLock } from '../lock.js'
import { registerQueryTool } from './tools/query.js'
import { registerContextTool } from './tools/context.js'
import { registerImpactTool } from './tools/impact.js'
import { registerDetectChangesTool } from './tools/detect-changes.js'
import { registerReindexTool } from './tools/reindex.js'

export interface McpDeps {
  store: GraphStore
  fts: FtsStore
  embedder: Embedder
  lock: WriteLock
  repoDir: string
  dataDir: string
  embeddingModel: string
}

export async function buildMcpApp(deps: McpDeps): Promise<Hono> {
  const server = new Server(
    { name: 'mac-graph', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )
  registerQueryTool(server, deps)
  registerContextTool(server, deps)
  registerImpactTool(server, deps)
  registerDetectChangesTool(server, deps)
  registerReindexTool(server, deps)

  // Use WebStandardStreamableHTTPServerTransport — designed for Hono/Cloudflare/Bun
  // (web-standard Request → Response). The Node.js StreamableHTTPServerTransport
  // wraps this for Express/IncomingMessage but is wrong for Hono.
  // Omitting sessionIdGenerator puts the transport in stateless mode.
  const transport = new WebStandardStreamableHTTPServerTransport()
  await server.connect(transport)

  const app = new Hono()
  app.all('/mcp', async c => {
    // handleRequest(req: Request): Promise<Response> — native Hono fit
    return transport.handleRequest(c.req.raw)
  })
  return app
}
