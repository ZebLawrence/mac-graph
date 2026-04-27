// See src/mcp/tools/query.ts for the registration pattern used by T20–T24.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readManifest } from '../../store/manifest.js'
import { enumerateSources } from '../../indexer/enumerate.js'
import type { McpDeps } from '../server.js'

export function registerDetectChangesTool(mcp: McpServer, deps: McpDeps): void {
  mcp.tool(
    'detect_changes',
    'Compare current /repo state against the indexed snapshot. Returns added/modified/deleted files.',
    {},
    async () => {
      const manifest = await readManifest(deps.dataDir)

      const sources = await enumerateSources(deps.repoDir)

      const dbRows = await deps.store.raw<{ path: string; sha: string }>(
        'MATCH (f:File) RETURN f.path AS path, f.sha AS sha'
      )

      const dbMap = new Map<string, string>()
      for (const row of dbRows) {
        dbMap.set(row.path, row.sha)
      }

      const enumPaths = new Set<string>()
      const changed_files: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> = []

      for (const file of sources) {
        enumPaths.add(file.relPath)
        const text = await readFile(file.absPath, 'utf8').catch(() => '')
        const sha = createHash('sha1').update(text).digest('hex')
        const dbSha = dbMap.get(file.relPath)
        if (dbSha === undefined) {
          changed_files.push({ path: file.relPath, status: 'added' })
        } else if (sha !== dbSha) {
          changed_files.push({ path: file.relPath, status: 'modified' })
        }
      }

      for (const dbPath of dbMap.keys()) {
        if (!enumPaths.has(dbPath)) {
          changed_files.push({ path: dbPath, status: 'deleted' })
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              manifest,
              changed_files,
              index_stale: changed_files.length > 0,
            }),
          },
        ],
      }
    },
  )
}
