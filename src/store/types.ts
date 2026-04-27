// src/store/types.ts
export type Language = 'ts' | 'js' | 'html' | 'css' | 'json' | 'other'

export type SymbolKind =
  | 'function' | 'class' | 'method' | 'interface'
  | 'type' | 'variable'
  | 'html-id' | 'css-class' | 'css-id' | 'css-var'
  | 'json-key' | 'custom-element'

export type RefKind = 'call' | 'type-ref' | 'extends' | 'implements' | 'read' | 'write'

export interface SymbolNode {
  id: string
  name: string
  kind: SymbolKind
  language: Language
  filePath: string
  startLine: number
  startCol: number
  endLine: number
  endCol: number
  signature: string
  doc: string
  clusterId: string         // '' if unset
}

export interface FileNode {
  path: string
  language: Language
  sha: string
  sizeBytes: bigint
  loc: number
}

export interface ChunkNode {
  id: string                // filePath + ':' + startLine + '-' + endLine
  filePath: string
  startLine: number
  endLine: number
  text: string
  symbolId: string          // '' if unset
  embedding: number[]       // length 384
}

export interface ModuleNode {
  specifier: string
  isExternal: boolean
}

export interface ReferenceEdge {
  fromSymbolId: string
  toSymbolId: string
  kind: RefKind
  refLine: number
  refCol: number
}

export interface Manifest {
  schemaVersion: number     // increment on breaking schema change
  indexedAt: string         // ISO 8601
  commitSha?: string
  fileCount: number
  symbolCount: number
  embeddingModel: string
  embeddingDim: number
}
