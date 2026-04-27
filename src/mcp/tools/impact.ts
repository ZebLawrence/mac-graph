// See src/mcp/tools/query.ts for the registration pattern used by T20–T24.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ImpactInput } from '../schemas.js'
import type { McpDeps } from '../server.js'

const TEST_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/

function shape(s: any) {
  return {
    id: s.id, name: s.name, kind: s.kind, language: s.language,
    file_path: s.file_path, start_line: s.start_line, end_line: s.end_line
  }
}

export function registerImpactTool(mcp: McpServer, deps: McpDeps): void {
  mcp.tool(
    'impact',
    'Blast radius of changing a symbol: direct + transitive callers, files & tests affected.',
    {
      symbol_id: z.string(),
      hops: z.number().int().min(1).max(4).optional(),
    },
    async (args) => {
      const parsed = ImpactInput.parse(args as unknown)
      const hops = parsed.hops ?? 2

      // 1. Look up target symbol
      const symRows = await deps.store.raw<{ s: any }>(
        `MATCH (s:Symbol {id: $id}) RETURN s`,
        { id: parsed.symbol_id }
      )
      if (!symRows[0]) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'symbol_not_found' }) }]
        }
      }
      const target = symRows[0].s

      // 2. Direct callers
      const directRows = await deps.store.raw<{ caller: any; ref_line: number }>(
        `MATCH (caller:Symbol)-[r:REFERENCES {kind:'call'}]->(t:Symbol {id: $id})
         RETURN caller, r.ref_line AS ref_line LIMIT 200`,
        { id: parsed.symbol_id }
      )

      // 3. Transitive callers — hops must be string-interpolated (kuzu *1..N does not accept N as a param)
      // Validated above: hops ∈ [1,4]
      // Use lambda filter syntax for relationship property filtering in variable-length paths.
      // Return pathNames as an array and join in TS (avoid relying on openCypher reduce syntax).
      let transitiveRows: Array<{ caller: any; depth: number; pathNames: string[] }> = []
      try {
        transitiveRows = await deps.store.raw<{ caller: any; depth: number; pathNames: string[] }>(
          `MATCH p=(caller:Symbol)-[r:REFERENCES*1..${hops} (r, n | WHERE r.kind = 'call')]->(t:Symbol {id: $id})
           WHERE caller.id <> $id
           WITH caller, length(p) AS depth, properties(nodes(p), 'name') AS pathNames
           RETURN caller, depth, pathNames
           LIMIT 200`,
          { id: parsed.symbol_id }
        )
      } catch {
        // If variable-length path query fails (e.g., property filter not supported),
        // fall back to empty — direct callers still give value.
        transitiveRows = []
      }

      // 4. Type consumers
      const typeRows = await deps.store.raw<{ s: any }>(
        `MATCH (s:Symbol)-[r:REFERENCES {kind:'type-ref'}]->(t:Symbol {id: $id})
         RETURN s LIMIT 100`,
        { id: parsed.symbol_id }
      )

      // 5. Aggregate file paths and filter for tests
      const fileSet = new Set<string>()
      for (const r of directRows) {
        if (r.caller?.file_path) fileSet.add(r.caller.file_path)
      }
      for (const r of transitiveRows) {
        if (r.caller?.file_path) fileSet.add(r.caller.file_path)
      }
      for (const r of typeRows) {
        if (r.s?.file_path) fileSet.add(r.s.file_path)
      }

      const filesAffected = Array.from(fileSet)
      const testsAffected = filesAffected.filter(f => TEST_RE.test(f))

      // 6. Build and return payload
      const payload = {
        symbol: shape(target),
        direct_callers: directRows.map(r => ({
          symbol: shape(r.caller),
          file_path: r.caller?.file_path ?? null,
          ref_line: r.ref_line
        })),
        transitive_callers: transitiveRows.map(r => ({
          symbol: shape(r.caller),
          depth: r.depth,
          paths: [Array.isArray(r.pathNames) ? r.pathNames.join('→') : String(r.pathNames)]
        })),
        type_consumers: typeRows.map(r => shape(r.s)),
        files_affected: filesAffected,
        tests_affected: testsAffected
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }]
      }
    }
  )
}
