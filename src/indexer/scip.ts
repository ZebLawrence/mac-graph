// src/indexer/scip.ts
// Deviation from plan: scip_pb.ts uses @bufbuild/protobuf (not protobufjs) with flat
// exports and camelCase field names. Deserialization uses fromBinary(IndexSchema, buf)
// rather than scip.Index.deserialize(buf). All field accesses are camelCase
// (relativePath, symbolRoles, syntaxKind, signatureDocumentation, etc.) instead of
// the plan's snake_case (relative_path, symbol_roles, etc.).

import { spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
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

export async function runScip(repoDir: string): Promise<Index> {
  // Use a unique name in OS tmpdir to avoid races when multiple tests run concurrently.
  const out = join(tmpdir(), `.mac-graph-${randomBytes(6).toString('hex')}.scip`)
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'npx',
      ['scip-typescript', 'index', '--cwd', repoDir, '--output', out],
      { stdio: ['ignore', 'pipe', 'pipe'] }
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
