// Registration pattern for T20–T24:
//
//   Each tool file exports a `registerXxxTool(mcp: McpServer, deps: McpDeps): void`
//   function that calls `mcp.tool(name, description, zodShape, handler)`.
//
//   McpServer (high-level SDK class) maintains an internal tool registry and
//   installs a single ListTools + CallTool request handler pair lazily on first
//   `tool()` call.  This avoids the single-handler-per-method limitation of the
//   low-level `Server.setRequestHandler` API, which would cause the last
//   registered tool to silently win over all earlier ones.
//
//   To add a new tool (T21–T24): import McpServer + McpDeps, export your
//   `registerXxxTool`, and call it from buildMcpApp in src/mcp/server.ts.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { QueryInput } from '../schemas.js'
import { runQuery, type QueryInput as RunQueryInput } from '../../search/query.js'
import type { McpDeps } from '../server.js'

export function registerQueryTool(mcp: McpServer, deps: McpDeps): void {
  mcp.tool(
    'query',
    'Hybrid semantic + keyword search over the indexed code graph. Returns ranked symbol hits.',
    {
      q: z.string().min(1).describe('Search query string'),
      limit: z.number().int().positive().max(100).optional().describe('Max results (default 10)'),
      kinds: z
        .array(z.enum(['function','class','method','interface','type','variable',
          'html-id','css-class','css-id','css-var','json-key','custom-element']))
        .optional()
        .describe('Filter by symbol kind'),
      languages: z
        .array(z.enum(['ts','js','html','css','json','other']))
        .optional()
        .describe('Filter by language'),
    },
    async (args) => {
      const parsed = QueryInput.parse(args as unknown) as RunQueryInput
      const results = await runQuery(
        { store: deps.store, fts: deps.fts, embedder: deps.embedder },
        parsed,
      )
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ results }),
          },
        ],
      }
    },
  )
}
