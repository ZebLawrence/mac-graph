// src/indexer/scip.ts
// Deviation from plan: scip_pb.ts uses @bufbuild/protobuf (not protobufjs) with flat
// exports and camelCase field names. Deserialization uses fromBinary(IndexSchema, buf)
// rather than scip.Index.deserialize(buf). All field accesses are camelCase
// (relativePath, symbolRoles, syntaxKind, signatureDocumentation, etc.) instead of
// the plan's snake_case (relative_path, symbol_roles, etc.).

import { spawn } from 'node:child_process'
import { readFile, unlink, access, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { join, dirname, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fromBinary } from '@bufbuild/protobuf'
import {
  IndexSchema,
  SymbolRole,
  SymbolInformation_Kind,
  type Index,
  type Document,
  type SyntaxKind,
} from '../vendor/scip_pb.js'
import type { SymbolNode, ReferenceEdge, RefKind } from '../store/types.js'
import { env } from '../env.js'

export async function runScip(repoDir: string): Promise<Index> {
  // Use a unique name in OS tmpdir to avoid races when multiple tests run concurrently.
  const out = join(tmpdir(), `.mac-graph-${randomBytes(6).toString('hex')}.scip`)
  const tempConfigDir = join(tmpdir(), `.mac-graph-tsconfigs-${randomBytes(6).toString('hex')}`)
  try {
    // Resolve project args, creating synthetic tsconfigs in tempConfigDir for any
    // referenced sub-projects that lack a tsconfig.json in the (read-only) repo dir.
    const projectArgs = await prepareProjectArgs(repoDir, tempConfigDir)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        'npx',
        ['scip-typescript', 'index', '--no-progress-bar', '--cwd', repoDir, '--output', out, ...projectArgs],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${env.SCIP_HEAP_MB}` },
        }
      )
      let stderr = ''
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      proc.on('close', code =>
        code === 0 ? resolve() : reject(new Error(`scip-typescript exit ${code}: ${stderr}`))
      )
    })
    const buf = await readFile(out)
    // Clean up temp file (best-effort)
    unlink(out).catch(() => undefined)
    return fromBinary(IndexSchema, buf)
  } finally {
    rm(tempConfigDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Determine the list of explicit project paths to pass to scip-typescript.
 *
 * If the root tsconfig.json has project references, we check each referenced
 * directory for a tsconfig.json.  For any that are missing (e.g. because /repo
 * is mounted read-only) we write a synthetic tsconfig into a writable tempDir
 * that tells TypeScript to include all TS/JS files from the actual source path.
 * Passing explicit project args with --cwd repoDir preserves the correct
 * relative file paths in the SCIP output.
 */
async function prepareProjectArgs(repoDir: string, tempDir: string): Promise<string[]> {
  const rootTsconfigPath = join(repoDir, 'tsconfig.json')

  let rootContent: string
  try {
    rootContent = await readFile(rootTsconfigPath, 'utf8')
  } catch {
    // No root tsconfig — create a synthetic one covering the whole repo.
    return [await createSyntheticTsconfig(repoDir, tempDir, repoDir)]
  }

  let rootConfig: { references?: Array<{ path: string }> }
  try {
    rootConfig = JSON.parse(rootContent)
  } catch {
    // tsconfig contains JSONC comments or is otherwise unparseable — pass it
    // directly and let scip-typescript handle it.
    return [rootTsconfigPath]
  }

  const references = rootConfig.references
  if (!references || references.length === 0) {
    return [rootTsconfigPath]
  }

  const projects: string[] = []
  for (const ref of references) {
    const refAbsPath = resolve(repoDir, ref.path)

    // Determine whether the reference points at a directory or a tsconfig file.
    let tsconfigPath: string
    let sourceDir: string
    try {
      const s = await stat(refAbsPath)
      if (s.isDirectory()) {
        tsconfigPath = join(refAbsPath, 'tsconfig.json')
        sourceDir = refAbsPath
      } else {
        tsconfigPath = refAbsPath
        sourceDir = dirname(refAbsPath)
      }
    } catch {
      // Path doesn't exist yet — treat as a directory reference.
      tsconfigPath = join(refAbsPath, 'tsconfig.json')
      sourceDir = refAbsPath
    }

    try {
      await access(tsconfigPath)
      projects.push(tsconfigPath) // exists — use as-is
    } catch {
      // Missing tsconfig — synthesise one in the writable tempDir.
      projects.push(await createSyntheticTsconfig(repoDir, tempDir, sourceDir))
    }
  }

  return projects
}

/**
 * Write a minimal tsconfig.json inside tempDir that indexes all TS/JS files
 * under sourceDir.  The file is placed at a path mirroring the sourceDir
 * structure relative to repoDir so that any intra-project imports resolve.
 */
async function createSyntheticTsconfig(repoDir: string, tempDir: string, sourceDir: string): Promise<string> {
  const relToRepo = relative(repoDir, sourceDir)
  const tempSubDir = relToRepo ? join(tempDir, relToRepo) : tempDir
  await mkdir(tempSubDir, { recursive: true })

  const tsconfigPath = join(tempSubDir, 'tsconfig.json')
  const config = {
    compilerOptions: { allowJs: true, rootDir: sourceDir },
    include: [`${sourceDir}/**/*.ts`, `${sourceDir}/**/*.tsx`, `${sourceDir}/**/*.js`],
  }
  await writeFile(tsconfigPath, JSON.stringify(config, null, 2))
  return tsconfigPath
}

export interface ParsedScip {
  symbols: SymbolNode[]
  references: ReferenceEdge[]
  fileSymbols: Map<string, string[]>  // file path → symbol ids
}

export function parseScipIndex(idx: Index, _repoDir: string): ParsedScip {
  const symbols: SymbolNode[] = []
  const references: ReferenceEdge[] = []
  const fileSymbols = new Map<string, string[]>()

  for (const doc of idx.documents) {
    // camelCase: relativePath (not relative_path)
    const filePath = doc.relativePath
    const ids: string[] = []

    for (const sym of doc.symbols) {
      const node: SymbolNode = {
        id: sym.symbol,
        name: lastSymbolPart(sym.symbol),
        kind: mapKind(sym.kind),
        language: 'ts',
        filePath,
        startLine: 0, startCol: 0, endLine: 0, endCol: 0,
        // camelCase: signatureDocumentation (not signature_documentation)
        signature: sym.signatureDocumentation?.text ?? '',
        doc: (sym.documentation ?? []).join('\n\n'),
        clusterId: '',
      }
      symbols.push(node)
      ids.push(sym.symbol)
    }

    for (const occ of doc.occurrences) {
      const [sl, sc, el, ec] = readRange(occ.range)
      // camelCase: symbolRoles (not symbol_roles)
      const isDefinition = (occ.symbolRoles & SymbolRole.Definition) !== 0

      if (isDefinition) {
        const owner = symbols.find(s => s.id === occ.symbol && s.filePath === filePath)
        if (owner) {
          owner.startLine = sl + 1; owner.startCol = sc
          owner.endLine = el + 1; owner.endCol = ec
        }
      } else {
        // Reference occurrence: find enclosing definition to emit an edge
        const enclosing = findEnclosingSymbol(doc, sl)
        if (enclosing && enclosing !== occ.symbol) {
          references.push({
            fromSymbolId: enclosing,
            toSymbolId: occ.symbol,
            kind: refKindFromRoles(occ.symbolRoles, occ.syntaxKind),
            refLine: sl + 1,
            refCol: sc,
          })
        }
      }
    }

    fileSymbols.set(filePath, ids)
  }

  return { symbols, references, fileSymbols }
}

function readRange(range: number[]): [number, number, number, number] {
  // SCIP encoding: 3 elements = [startLine, startCol, endCol] (single-line)
  //                4 elements = [startLine, startCol, endLine, endCol]
  if (range.length === 3) return [range[0]!, range[1]!, range[0]!, range[2]!]
  return [range[0]!, range[1]!, range[2]!, range[3]!]
}

function findEnclosingSymbol(doc: Document, refLine: number): string | null {
  // Find the definition occurrence whose range contains refLine.
  // For top-level functions in a single file, the definition occurrence's start
  // and end line are the same (range is just the identifier span), so we match
  // by equality: the definition on the same line as the reference.
  for (const occ of doc.occurrences) {
    if ((occ.symbolRoles & SymbolRole.Definition) === 0) continue
    const [sl, , el] = readRange(occ.range)
    if (sl <= refLine && refLine <= el) return occ.symbol
  }
  return null
}

function refKindFromRoles(roles: number, _syntaxKind: SyntaxKind): RefKind {
  if (roles & SymbolRole.WriteAccess) return 'write'
  if (roles & SymbolRole.ReadAccess) return 'read'
  // SCIP doesn't directly encode call vs type-ref; default 'call'.
  return 'call'
}

function mapKind(k: SymbolInformation_Kind): SymbolNode['kind'] {
  switch (k) {
    case SymbolInformation_Kind.Function: return 'function'
    case SymbolInformation_Kind.Method: return 'method'
    case SymbolInformation_Kind.Class: return 'class'
    case SymbolInformation_Kind.Interface: return 'interface'
    case SymbolInformation_Kind.TypeAlias: return 'type'
    default: return 'variable'
  }
}

function lastSymbolPart(s: string): string {
  // SCIP symbol format: "<scheme> <pkg-mgr> <pkg-name> <version> <descriptors>"
  // Descriptors live after the last backtick-enclosed path, e.g.:
  //   `a.ts`/greet(). → 'greet'
  //   `a.ts`/shout().(name) → 'name'
  // Strip everything up to and including the backtick-path segment, then find
  // the last word-char run before '(', '.', or end.
  const afterPath = s.replace(/.*`[^`]*`/, '')
  if (!afterPath || afterPath === '/') {
    // File-level or unrecognized — return last space-delimited token
    return s.split(' ').pop() ?? s
  }
  const matches = afterPath.match(/[A-Za-z0-9_$]+(?=[.(]|$)/g)
  if (matches && matches.length > 0) return matches[matches.length - 1]!
  return s
}
