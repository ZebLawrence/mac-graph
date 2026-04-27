import Parser from 'tree-sitter'
import JSON_LANG from 'tree-sitter-json'
import type { SymbolNode } from '../../store/types.js'

const parser = new Parser()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
parser.setLanguage(JSON_LANG as any)

export function extractJsonSymbols(filePath: string, source: string): SymbolNode[] {
  const tree = parser.parse(source)
  const out: SymbolNode[] = []
  // rootNode is 'document'; first named child should be the top-level 'object'
  const root = tree.rootNode.namedChildren?.[0]
  if (!root || root.type !== 'object') return out
  for (const pair of root.namedChildren ?? []) {
    if (pair.type !== 'pair') continue
    const keyNode = pair.namedChildren?.[0]
    if (!keyNode || keyNode.type !== 'string') continue
    // Use string_content child if available, otherwise strip quotes from text
    const nameContent = keyNode.namedChildren?.[0]?.text ?? keyNode.text.replace(/['"]/g, '')
    out.push({
      id: `json:${filePath}:${nameContent}`,
      name: nameContent, kind: 'json-key', language: 'json', filePath,
      startLine: keyNode.startPosition.row + 1, startCol: keyNode.startPosition.column,
      endLine: keyNode.endPosition.row + 1, endCol: keyNode.endPosition.column,
      signature: '', doc: '', clusterId: ''
    })
  }
  return out
}
