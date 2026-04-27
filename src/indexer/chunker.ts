const MAX_LINES = 30
const OVERLAP = 5

export interface SymbolRange {
  id: string
  startLine: number
  endLine: number
}

export interface ChunkInput {
  filePath: string
  text: string
  symbols: SymbolRange[]
}

export interface ChunkResult {
  id: string
  filePath: string
  startLine: number
  endLine: number
  text: string
  symbolId: string
}

export function chunkFile(input: ChunkInput): ChunkResult[] {
  // Strip trailing newline before splitting so 'a\nb\nc\n' → ['a','b','c'] (3 lines, not 4)
  const normalised = input.text.endsWith('\n') ? input.text.slice(0, -1) : input.text
  const lines = normalised.split('\n')

  if (input.symbols.length > 0) {
    return input.symbols.map(s => buildChunk(input.filePath, lines, s.startLine, s.endLine, s.id))
  }
  return slidingWindow(input.filePath, lines)
}

function slidingWindow(filePath: string, lines: string[]): ChunkResult[] {
  if (lines.length <= MAX_LINES) {
    return [buildChunk(filePath, lines, 1, lines.length, '')]
  }
  const out: ChunkResult[] = []
  let start = 1
  while (start <= lines.length) {
    const end = Math.min(start + MAX_LINES - 1, lines.length)
    out.push(buildChunk(filePath, lines, start, end, ''))
    if (end === lines.length) break
    start = end - OVERLAP + 1
  }
  return out
}

function buildChunk(
  filePath: string,
  lines: string[],
  startLine: number,
  endLine: number,
  symbolId: string,
): ChunkResult {
  const text = lines.slice(startLine - 1, endLine).join('\n')
  return {
    id: `${filePath}:${startLine}-${endLine}`,
    filePath,
    startLine,
    endLine,
    text,
    symbolId,
  }
}
