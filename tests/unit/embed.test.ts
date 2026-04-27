import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Embedder } from '../../src/indexer/embed.js'

beforeAll(() => {
  process.env.TRANSFORMERS_CACHE = mkdtempSync(join(tmpdir(), 'mg-tx-'))
})

describe('Embedder', () => {
  it('returns 384-dim vectors for bge-small-en-v1.5', async () => {
    const e = new Embedder('Xenova/bge-small-en-v1.5')
    const [v] = await e.embed(['hello world'])
    expect(v).toHaveLength(384)
    expect(v!.every(x => typeof x === 'number')).toBe(true)
  }, 120_000)

  it('batches multiple inputs', async () => {
    const e = new Embedder('Xenova/bge-small-en-v1.5')
    const out = await e.embed(['a', 'b', 'c'])
    expect(out).toHaveLength(3)
    expect(out[0]).toHaveLength(384)
  }, 120_000)
})
