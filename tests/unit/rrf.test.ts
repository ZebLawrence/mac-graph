import { describe, it, expect } from 'vitest'
import { reciprocalRankFusion } from '../../src/search/rrf.js'

describe('reciprocalRankFusion', () => {
  it('fuses two ranked lists with k=60', () => {
    const a = ['x', 'y', 'z']
    const b = ['z', 'y', 'x']
    const fused = reciprocalRankFusion([a, b], 60)
    // x and z each appear at rank 1 in one list, rank 3 in the other — tied highest score
    // y appears at rank 2 in both — slightly lower score than x and z
    const ids = fused.map(r => r.id)
    expect(ids.slice(0, 2).sort()).toEqual(['x', 'z'])  // x and z tied at top
    expect(ids[2]).toBe('y')                             // y last
    expect(fused[0]!.score).toBeGreaterThan(fused[2]!.score) // top > bottom
  })

  it('handles missing entries gracefully', () => {
    const a = ['x', 'y']
    const b = ['z', 'x']
    const fused = reciprocalRankFusion([a, b], 60)
    expect(fused.map(r => r.id).sort()).toEqual(['x', 'y', 'z'])
  })
})
