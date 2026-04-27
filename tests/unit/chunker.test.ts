import { describe, it, expect } from 'vitest'
import { chunkFile } from '../../src/indexer/chunker.js'

const SHORT = 'line1\nline2\nline3\n'

describe('chunkFile', () => {
  it('emits a single chunk for short files (no symbols)', () => {
    const chunks = chunkFile({ filePath: 'a.css', text: SHORT, symbols: [] })
    expect(chunks.length).toBe(1)
    expect(chunks[0]?.startLine).toBe(1)
    expect(chunks[0]?.endLine).toBe(3)
    expect(chunks[0]?.symbolId).toBe('')
  })

  it('chunks at symbol boundaries when provided', () => {
    const text = Array.from({ length: 60 }, (_, i) => `l${i + 1}`).join('\n')
    const chunks = chunkFile({
      filePath: 'a.ts',
      text,
      symbols: [
        { id: 's1', startLine: 1, endLine: 20 },
        { id: 's2', startLine: 21, endLine: 60 }
      ]
    })
    expect(chunks.length).toBe(2)
    expect(chunks[0]?.symbolId).toBe('s1')
    expect(chunks[1]?.symbolId).toBe('s2')
  })

  it('sliding-windows long non-code files', () => {
    const text = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join('\n')
    const chunks = chunkFile({ filePath: 'a.css', text, symbols: [] })
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks[0]?.startLine).toBe(1)
    expect(chunks[1]!.startLine).toBeLessThan(chunks[0]!.endLine)  // overlap
  })
})
