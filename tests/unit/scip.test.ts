import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScip, parseScipIndex } from '../../src/indexer/scip.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FIX = join(__dirname, '../../fixtures/scip-tiny')

describe('scip', () => {
  it('runs scip-typescript and returns symbols + references', async () => {
    const idx = await runScip(FIX)
    const parsed = parseScipIndex(idx, FIX)
    const names = parsed.symbols.map(s => s.name).sort()
    expect(names).toContain('greet')
    expect(names).toContain('shout')

    // shout calls greet → at least one REFERENCES edge between them
    const greet = parsed.symbols.find(s => s.name === 'greet')!
    const shout = parsed.symbols.find(s => s.name === 'shout')!
    const callEdge = parsed.references.find(
      r => r.fromSymbolId === shout.id && r.toSymbolId === greet.id && r.kind === 'call'
    )
    expect(callEdge).toBeTruthy()
  }, 120_000)
})
