import { Hono } from 'hono'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
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

/**
 * Create a fresh McpServer pre-registered with all tools.
 *
 * McpServer (high-level SDK class) maintains a tool registry and installs a
 * single ListTools + CallTool handler pair.  Each registerXxxTool call adds
 * one entry to that registry via mcp.tool().  See tools/query.ts for the full
 * pattern description.
 *
 * NOTE: The WebStandardStreamableHTTPServerTransport in stateless mode cannot
 * be reused across requests ("Stateless transport cannot be reused").  The
 * McpServer is also single-transport-at-a-time.  We therefore build a new
 * server + transport for every incoming request — both are lightweight objects
 * with no I/O open between requests.
 */
function buildMcpServer(deps: McpDeps): McpServer {
  const mcp = new McpServer(
    { name: 'mac-graph', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )
  registerQueryTool(mcp, deps)
  registerContextTool(mcp, deps)
  registerImpactTool(mcp, deps)
  registerDetectChangesTool(mcp, deps)
  registerReindexTool(mcp, deps)
  return mcp
}

export async function buildMcpApp(deps: McpDeps): Promise<Hono> {
  const app = new Hono()

  app.all('/mcp', async c => {
    // Create a new server + transport per request.
    // enableJsonResponse: true forces the transport to return application/json
    // instead of text/event-stream for single-request round-trips.
    const mcp = buildMcpServer(deps)
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    })
    await mcp.connect(transport)
    return transport.handleRequest(c.req.raw)
  })

  return app
}
