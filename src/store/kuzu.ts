import * as kuzu from 'kuzu'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { applySchema } from './kuzu-schema.js'
import type {
  FileNode, SymbolNode, ChunkNode, ModuleNode, ReferenceEdge
} from './types.js'

export class GraphStore {
  private constructor(
    private db: kuzu.Database,
    private conn: kuzu.Connection
  ) {}

  static async open(path: string): Promise<GraphStore> {
    await mkdir(dirname(path), { recursive: true })
    const db = new kuzu.Database(path)
    const conn = new kuzu.Connection(db)
    await applySchema(conn)
    return new GraphStore(db, conn)
  }

  async close(): Promise<void> {
    await this.db.close()
  }

  /**
   * Prepare + execute a parameterized Cypher query.
   * kuzu's `connection.query()` does NOT accept a params object — only a
   * progress callback. Parameterized execution requires prepare() + execute().
   */
  private async pquery(
    cypher: string,
    params: Record<string, unknown> = {}
  ): Promise<kuzu.QueryResult> {
    const prepared = await this.conn.prepare(cypher)
    const result = await this.conn.execute(prepared, params as Record<string, kuzu.KuzuValue>)
    // execute() may return a single QueryResult or an array; normalise to one
    return Array.isArray(result) ? result[0]! : result
  }

  async upsertFile(f: FileNode): Promise<void> {
    await this.pquery(
      `MERGE (n:File {path: $path})
       SET n.language = $language, n.sha = $sha,
           n.size_bytes = $size_bytes, n.loc = $loc`,
      {
        path: f.path, language: f.language, sha: f.sha,
        size_bytes: f.sizeBytes, loc: f.loc
      }
    )
  }

  async getFile(path: string): Promise<FileNode | null> {
    const r = await this.pquery(
      `MATCH (n:File {path: $path}) RETURN n`,
      { path }
    )
    const rows = await r.getAll()
    if (rows.length === 0) return null
    const n = (rows[0] as any).n
    return {
      path: n.path, language: n.language, sha: n.sha,
      sizeBytes: BigInt(n.size_bytes), loc: n.loc
    }
  }

  async upsertSymbol(s: SymbolNode): Promise<void> {
    await this.pquery(
      `MERGE (n:Symbol {id: $id})
       SET n.name = $name, n.kind = $kind, n.language = $language,
           n.file_path = $file_path,
           n.start_line = $start_line, n.start_col = $start_col,
           n.end_line = $end_line, n.end_col = $end_col,
           n.signature = $signature, n.doc = $doc, n.cluster_id = $cluster_id`,
      {
        id: s.id, name: s.name, kind: s.kind, language: s.language,
        file_path: s.filePath,
        start_line: s.startLine, start_col: s.startCol,
        end_line: s.endLine, end_col: s.endCol,
        signature: s.signature, doc: s.doc, cluster_id: s.clusterId
      }
    )
  }

  async linkContains(filePath: string, symbolId: string): Promise<void> {
    await this.pquery(
      `MATCH (f:File {path: $file_path}), (s:Symbol {id: $sym_id})
       MERGE (f)-[:CONTAINS]->(s)`,
      { file_path: filePath, sym_id: symbolId }
    )
  }

  async symbolsInFile(filePath: string): Promise<SymbolNode[]> {
    const r = await this.pquery(
      `MATCH (f:File {path: $path})-[:CONTAINS]->(s:Symbol) RETURN s`,
      { path: filePath }
    )
    const rows = await r.getAll()
    return rows.map((row: any) => mapSymbol(row.s))
  }

  async upsertChunk(c: ChunkNode): Promise<void> {
    await this.pquery(
      `MERGE (n:Chunk {id: $id})
       SET n.file_path = $file_path, n.start_line = $start_line,
           n.end_line = $end_line, n.text = $text,
           n.symbol_id = $symbol_id, n.embedding = $embedding`,
      {
        id: c.id, file_path: c.filePath,
        start_line: c.startLine, end_line: c.endLine,
        text: c.text, symbol_id: c.symbolId, embedding: c.embedding
      }
    )
  }

  async upsertReference(r: ReferenceEdge): Promise<void> {
    await this.pquery(
      `MATCH (a:Symbol {id: $from}), (b:Symbol {id: $to})
       CREATE (a)-[:REFERENCES {kind: $kind, ref_line: $line, ref_col: $col}]->(b)`,
      { from: r.fromSymbolId, to: r.toSymbolId, kind: r.kind, line: r.refLine, col: r.refCol }
    )
  }

  async upsertModule(m: ModuleNode): Promise<void> {
    await this.pquery(
      `MERGE (n:Module {specifier: $spec}) SET n.is_external = $ext`,
      { spec: m.specifier, ext: m.isExternal }
    )
  }

  async truncateAll(): Promise<void> {
    for (const t of ['File', 'Symbol', 'Chunk', 'Module', 'WikiPage']) {
      await this.conn.query(`MATCH (n:${t}) DETACH DELETE n`)
    }
  }

  /** Escape hatch for ad-hoc queries from indexer/search code. */
  async raw<T = unknown>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const r = await this.pquery(cypher, params)
    return (await r.getAll()) as T[]
  }
}

function mapSymbol(n: any): SymbolNode {
  return {
    id: n.id, name: n.name, kind: n.kind, language: n.language,
    filePath: n.file_path,
    startLine: n.start_line, startCol: n.start_col,
    endLine: n.end_line, endCol: n.end_col,
    signature: n.signature, doc: n.doc, clusterId: n.cluster_id
  }
}
