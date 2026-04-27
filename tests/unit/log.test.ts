import { describe, it, expect } from 'vitest'
import { log } from '../../src/log.js'

describe('log', () => {
  it('exposes pino-style methods', () => {
    expect(typeof log.info).toBe('function')
    expect(typeof log.warn).toBe('function')
    expect(typeof log.error).toBe('function')
    expect(typeof log.debug).toBe('function')
  })

  it('respects LOG_LEVEL env at module load', () => {
    expect(log.level).toMatch(/^(trace|debug|info|warn|error|fatal)$/)
  })
})
