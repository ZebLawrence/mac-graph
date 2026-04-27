// tests/unit/manifest.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, writeManifest } from '../../src/store/manifest.js'

describe('manifest', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mg-m-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns null when missing', async () => {
    expect(await readManifest(dir)).toBeNull()
  })

  it('round-trips through write+read', async () => {
    await writeManifest(dir, {
      schemaVersion: 1, indexedAt: '2026-04-26T00:00:00Z',
      fileCount: 3, symbolCount: 12,
      embeddingModel: 'm', embeddingDim: 384
    })
    const got = await readManifest(dir)
    expect(got?.schemaVersion).toBe(1)
    expect(got?.fileCount).toBe(3)
  })
})
