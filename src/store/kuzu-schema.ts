import * as kuzu from 'kuzu'

export const SCHEMA_VERSION = 1

const STATEMENTS: string[] = [
  `CREATE NODE TABLE IF NOT EXISTS File(
     path STRING, language STRING, sha STRING, size_bytes INT64, loc INT32,
     PRIMARY KEY (path)
   )`,
  `CREATE NODE TABLE IF NOT EXISTS Symbol(
     id STRING, name STRING, kind STRING, language STRING,
     file_path STRING,
     start_line INT32, start_col INT32, end_line INT32, end_col INT32,
     signature STRING, doc STRING, cluster_id STRING,
     PRIMARY KEY (id)
   )`,
  `CREATE NODE TABLE IF NOT EXISTS Chunk(
     id STRING, file_path STRING, start_line INT32, end_line INT32,
     text STRING, symbol_id STRING, embedding FLOAT[384],
     PRIMARY KEY (id)
   )`,
  `CREATE NODE TABLE IF NOT EXISTS Module(
     specifier STRING, is_external BOOLEAN,
     PRIMARY KEY (specifier)
   )`,
  `CREATE NODE TABLE IF NOT EXISTS WikiPage(
     slug STRING, title STRING, kind STRING, generated_at TIMESTAMP,
     PRIMARY KEY (slug)
   )`,
  `CREATE REL TABLE IF NOT EXISTS CONTAINS(FROM File TO Symbol)`,
  `CREATE REL TABLE IF NOT EXISTS DEFINES(FROM Symbol TO Symbol)`,
  `CREATE REL TABLE IF NOT EXISTS REFERENCES(
     FROM Symbol TO Symbol,
     kind STRING, ref_line INT32, ref_col INT32
   )`,
  `CREATE REL TABLE IF NOT EXISTS IMPORTS(
     FROM File TO Module, imported_names STRING[]
   )`,
  `CREATE REL TABLE IF NOT EXISTS EXPORTS(FROM File TO Symbol)`,
  `CREATE REL TABLE IF NOT EXISTS CHUNKS(FROM File TO Chunk)`,
  `CREATE REL TABLE IF NOT EXISTS DOCUMENTS(FROM WikiPage TO Symbol)`
]

export async function applySchema(conn: kuzu.Connection): Promise<void> {
  for (const stmt of STATEMENTS) {
    await conn.query(stmt)
  }
}
