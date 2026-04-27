import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as kuzu from 'kuzu'
import { applySchema, SCHEMA_VERSION } from '../../src/store/kuzu-schema.js'

describe('kuzu schema', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mg-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates all node and rel tables idempotently', async () => {
    const db = new kuzu.Database(join(dir, 'kuzu'))
    const conn = new kuzu.Connection(db)
    await applySchema(conn)
    await applySchema(conn)  // second call is no-op

    const result = await conn.query("CALL show_tables() RETURN *") as kuzu.QueryResult
    const rows = await result.getAll()
    const names = rows.map((r: any) => r.name).sort()
    expect(names).toContain('Symbol')
    expect(names).toContain('File')
    expect(names).toContain('Chunk')
    expect(names).toContain('Module')
    expect(names).toContain('REFERENCES')
    expect(names).toContain('CONTAINS')
    expect(names).toContain('IMPORTS')

    await db.close()
  })

  it('exports a SCHEMA_VERSION integer', () => {
    expect(typeof SCHEMA_VERSION).toBe('number')
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
  })
})
