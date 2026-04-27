import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import ignore from 'ignore'
import type { Language } from '../store/types.js'

export interface EnumeratedFile {
  absPath: string
  relPath: string
  language: Language
  sizeBytes: bigint
}

const EXT_LANG: Record<string, Language> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'css',
  '.json': 'json'
}

export async function enumerateSources(repoDir: string): Promise<EnumeratedFile[]> {
  const ig = ignore()
  for (const f of ['.gitignore', '.mac-graph-ignore']) {
    try { ig.add(await readFile(join(repoDir, f), 'utf8')) } catch { /* missing is fine */ }
  }
  ig.add(['.git/', '.mac-graph-data/', '.mac-graph-wiki/', '.*'])

  const out: EnumeratedFile[] = []
  await walk(repoDir, '')

  return out

  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await readdir(abs, { withFileTypes: true })
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const childAbs = join(abs, e.name)
      const checkPath = e.isDirectory() ? `${childRel}/` : childRel
      if (ig.ignores(checkPath)) continue
      if (e.isDirectory()) {
        await walk(childAbs, childRel)
      } else if (e.isFile()) {
        const ext = extname(e.name)
        const language = EXT_LANG[ext] ?? 'other'
        const s = await stat(childAbs)
        out.push({ absPath: childAbs, relPath: childRel, language, sizeBytes: BigInt(s.size) })
      }
    }
  }
}

function extname(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i)
}
