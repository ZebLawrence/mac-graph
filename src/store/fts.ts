import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface FtsHit {
  id: string
  bm25: number  // lower = better in SQLite, we negate so higher = better
  filePath: string
}

export class FtsStore {
  private db: Database.Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        id UNINDEXED,
        file_path UNINDEXED,
        text,
        tokenize = 'porter unicode61'
      )
    `)
  }

  upsert(id: string, text: string): void {
    const filePath = id.split(':')[0] ?? ''
    this.db.prepare(`DELETE FROM chunks WHERE id = ?`).run(id)
    this.db.prepare(`INSERT INTO chunks (id, file_path, text) VALUES (?, ?, ?)`)
      .run(id, filePath, text)
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM chunks WHERE id = ?`).run(id)
  }

  removeByFile(filePath: string): void {
    this.db.prepare(`DELETE FROM chunks WHERE file_path = ?`).run(filePath)
  }

  search(query: string, limit: number): FtsHit[] {
    const rows = this.db.prepare(`
      SELECT id, file_path, bm25(chunks) AS score
      FROM chunks
      WHERE chunks MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(escape(query), limit) as Array<{ id: string; file_path: string; score: number }>
    return rows.map(r => ({ id: r.id, filePath: r.file_path, bm25: -r.score }))
  }

  close(): void { this.db.close() }
}

/** FTS5 query syntax escape: wrap free text in quotes. */
function escape(q: string): string {
  return `"${q.replace(/"/g, '""')}"`
}
