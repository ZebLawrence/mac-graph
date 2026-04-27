import { describe, it, expect } from 'vitest'
import { WriteLock } from '../../src/lock.js'

describe('WriteLock', () => {
  it('grants exclusive access', async () => {
    const lock = new WriteLock()
    let order: string[] = []
    await Promise.all([
      lock.acquire('a').then(async (release) => {
        order.push('a-start')
        await new Promise(r => setTimeout(r, 20))
        order.push('a-end')
        release()
      }),
      lock.acquire('b').then(async (release) => {
        order.push('b-start')
        order.push('b-end')
        release()
      })
    ])
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('reports current holder via inspect()', async () => {
    const lock = new WriteLock()
    const release = await lock.acquire('job-42')
    expect(lock.inspect()).toEqual({ held: true, holder: 'job-42' })
    release()
    expect(lock.inspect()).toEqual({ held: false, holder: null })
  })

  it('tryAcquire returns null when busy', async () => {
    const lock = new WriteLock()
    const release = await lock.acquire('a')
    expect(lock.tryAcquire('b')).toBeNull()
    release()
    const r2 = lock.tryAcquire('b')
    expect(r2).not.toBeNull()
    r2!()
  })
})
