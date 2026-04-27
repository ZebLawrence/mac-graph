// See src/mcp/tools/query.ts for the registration pattern used by T20–T24.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ContextInput } from '../schemas.js'
import type { McpDeps } from '../server.js'

function shape(s: any) {
  return {
    id: s.id, name: s.name, kind: s.kind, language: s.language,
    file_path: s.file_path, start_line: s.start_line, end_line: s.end_line
  }
}

export function registerContextTool(mcp: McpServer, deps: McpDeps): void {
  mcp.tool(
    'context',
    '360° view of a symbol: source, callers, callees, type refs, cluster mates.',
    {
      symbol_id: z.string().optional(),
      name: z.string().optional(),
      kind: z.enum([
        'function', 'class', 'method', 'interface', 'type', 'variable',
        'html-id', 'css-class', 'css-id', 'css-var', 'json-key', 'custom-element'
      ]).optional(),
      depth: z.number().int().min(1).max(3).optional(),
    },
    async (args) => {
      const parsed = ContextInput.parse(args as unknown)

      let symbol: any
      if (parsed.symbol_id) {
        const r = await deps.store.raw<{ s: any }>(
          `MATCH (s:Symbol {id: $id}) RETURN s`,
          { id: parsed.symbol_id }
        )
        symbol = r[0]?.s
      } else {
        if (parsed.kind) {
          const r = await deps.store.raw<{ s: any }>(
            `MATCH (s:Symbol) WHERE s.name = $name AND s.kind = $kind RETURN s LIMIT 1`,
            { name: parsed.name!, kind: parsed.kind }
          )
          symbol = r[0]?.s
        } else {
          const r = await deps.store.raw<{ s: any }>(
            `MATCH (s:Symbol) WHERE s.name = $name RETURN s LIMIT 1`,
            { name: parsed.name! }
          )
          symbol = r[0]?.s
        }
      }

      if (!symbol) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'symbol_not_found' }) }]
        }
      }

      const callers = await deps.store.raw<{ caller: any; ref_line: number }>(
        `MATCH (caller:Symbol)-[r:REFERENCES {kind:'call'}]->(target:Symbol {id: $id})
         RETURN caller, r.ref_line AS ref_line LIMIT 50`,
        { id: symbol.id }
      )
      const callees = await deps.store.raw<{ callee: any; ref_line: number }>(
        `MATCH (target:Symbol {id: $id})-[r:REFERENCES {kind:'call'}]->(callee:Symbol)
         RETURN callee, r.ref_line AS ref_line LIMIT 50`,
        { id: symbol.id }
      )
      const typeRefs = await deps.store.raw<{ t: any; ref_line: number }>(
        `MATCH (target:Symbol {id: $id})-[r:REFERENCES {kind:'type-ref'}]->(t:Symbol)
         RETURN t, r.ref_line AS ref_line LIMIT 50`,
        { id: symbol.id }
      )
      const cluster = symbol.cluster_id
        ? await deps.store.raw<{ s: any }>(
          `MATCH (s:Symbol {cluster_id: $c}) WHERE s.id <> $id RETURN s LIMIT 8`,
          { c: symbol.cluster_id, id: symbol.id }
        )
        : []

      let source = ''
      try {
        const fileText = await readFile(join(deps.repoDir, symbol.file_path), 'utf8')
        const lines = fileText.split('\n')
        source = lines.slice(symbol.start_line - 1, symbol.end_line).join('\n')
      } catch { /* file gone */ }

      const payload = {
        symbol: {
          id: symbol.id, name: symbol.name, kind: symbol.kind,
          file_path: symbol.file_path,
          start_line: symbol.start_line, end_line: symbol.end_line,
          signature: symbol.signature, doc: symbol.doc
        },
        defined_in: { file_path: symbol.file_path, language: symbol.language },
        source,
        imports: [],  // EXPORTS/IMPORTS rendering: phase-2 polish
        defines: [],  // children via DEFINES — same caveat
        callers: callers.map(r => ({ symbol: shape(r.caller), ref_line: r.ref_line })),
        callees: callees.map(r => ({ symbol: shape(r.callee), ref_line: r.ref_line })),
        type_refs: typeRefs.map(r => ({ symbol: shape(r.t), ref_line: r.ref_line })),
        same_cluster: cluster.map(r => shape(r.s))
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }]
      }
    }
  )
}
