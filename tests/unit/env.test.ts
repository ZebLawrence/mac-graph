import { describe, it, expect } from 'vitest'
import { parseEnv } from '../../src/env.js'

describe('parseEnv', () => {
  it('returns defaults when no overrides set', () => {
    const env = parseEnv({})
    expect(env.PORT).toBe(3030)
    expect(env.BIND_ALL).toBe(false)
    expect(env.DATA_DIR).toBe('/data')
    expect(env.REPO_DIR).toBe('/repo')
    expect(env.WIKI_DIR).toBe('/wiki')
    expect(env.EMBEDDING_MODEL).toBe('Xenova/bge-small-en-v1.5')
  })

  it('parses overrides', () => {
    const env = parseEnv({ PORT: '4040', BIND_ALL: '1', DATA_DIR: '/tmp/x' })
    expect(env.PORT).toBe(4040)
    expect(env.BIND_ALL).toBe(true)
    expect(env.DATA_DIR).toBe('/tmp/x')
  })

  it('rejects invalid PORT', () => {
    expect(() => parseEnv({ PORT: 'banana' })).toThrow()
  })
})
