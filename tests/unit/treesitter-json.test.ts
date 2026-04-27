import { describe, it, expect } from 'vitest'
import { extractJsonSymbols } from '../../src/indexer/treesitter/json.js'

describe('extractJsonSymbols', () => {
  it('finds top-level keys only', () => {
    const json = '{ "name": "foo", "version": "1.0.0", "deps": { "x": "1" } }'
    const out = extractJsonSymbols('a.json', json)
    const names = out.map(s => s.name).sort()
    expect(names).toEqual(['deps', 'name', 'version'])
    // depth-1 only: 'x' inside deps not included
    expect(names).not.toContain('x')
  })
})
