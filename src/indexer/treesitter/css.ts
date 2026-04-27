import Parser from 'tree-sitter'
import CSS from 'tree-sitter-css'
import type { SymbolNode } from '../../store/types.js'

const parser = new Parser()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
parser.setLanguage(CSS as any)

export function extractCssSymbols(filePath: string, source: string): SymbolNode[] {
  const tree = parser.parse(source)
  const out: SymbolNode[] = []
  walk(tree.rootNode, (node: any) => {
    if (node.type === 'class_selector') {
      // node.text includes leading dot, e.g. '.btn-primary'
      out.push(makeSymbol(filePath, node.text, 'css-class', node))
    } else if (node.type === 'id_selector') {
      // node.text includes leading hash, e.g. '#sidebar'
      out.push(makeSymbol(filePath, node.text, 'css-id', node))
    } else if (node.type === 'declaration') {
      // namedChildren[0] = property_name node
      const prop = node.namedChildren?.[0]
      if (prop?.text?.startsWith('--')) {
        out.push(makeSymbol(filePath, prop.text, 'css-var', node))
      }
    }
  })
  return out
}

function walk(node: any, fn: (n: any) => void): void {
  fn(node)
  for (const child of node.namedChildren ?? []) walk(child, fn)
}

function makeSymbol(filePath: string, name: string, kind: SymbolNode['kind'], node: any): SymbolNode {
  return {
    id: `css:${filePath}:${kind}:${name}:${node.startPosition.row}`,
    name, kind, language: 'css', filePath,
    startLine: node.startPosition.row + 1, startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1, endCol: node.endPosition.column,
    signature: '', doc: '', clusterId: ''
  }
}
