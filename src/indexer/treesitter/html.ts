import Parser from 'tree-sitter'
import HTML from 'tree-sitter-html'
import type { SymbolNode } from '../../store/types.js'

const parser = new Parser()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
parser.setLanguage(HTML as any)

export function extractHtmlSymbols(filePath: string, source: string): SymbolNode[] {
  const tree = parser.parse(source)
  const out: SymbolNode[] = []
  walk(tree.rootNode, (node: any) => {
    if (node.type === 'attribute') {
      // namedChildren[0] = attribute_name, namedChildren[1] = quoted_attribute_value
      const nameNode = node.namedChildren?.[0]
      const valueNode = node.namedChildren?.[1]
      if (nameNode?.text === 'id' && valueNode) {
        // quoted_attribute_value -> attribute_value child holds the raw text
        const rawValue = valueNode.namedChildren?.[0]?.text ?? valueNode.text.replace(/['"]/g, '')
        out.push(makeSymbol(filePath, `#${rawValue}`, 'html-id', node))
      }
    }
    if (node.type === 'element') {
      // start_tag is first named child; tag_name is its first named child
      const startTag = node.namedChildren?.[0]
      if (startTag?.type === 'start_tag') {
        const tagName = startTag.namedChildren?.[0]?.text
        if (tagName?.includes('-')) {
          out.push(makeSymbol(filePath, tagName, 'custom-element', node))
        }
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
    id: `html:${filePath}:${kind}:${name}:${node.startPosition.row}`,
    name, kind, language: 'html', filePath,
    startLine: node.startPosition.row + 1, startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1, endCol: node.endPosition.column,
    signature: '', doc: '', clusterId: ''
  }
}
