import { GraphStore } from '../store/kuzu.js'
import { FtsStore } from '../store/fts.js'
import { Embedder } from '../indexer/embed.js'
import { reciprocalRankFusion } from './rrf.js'

export interface QueryHit {
  symbolId: string
  name: string
  kind: string
  filePath: string
  line: number
  snippet: string
  score: number
}

export interface QueryDeps {
  store: GraphStore
  fts: FtsStore
  embedder: Embedder
}

export interface QueryInput {
  q: string
  limit?: number
  kinds?: string[]
  languages?: string[]
}

export async function runQuery(deps: QueryDeps, input: QueryInput): Promise<QueryHit[]> {
  const limit = input.limit ?? 10

  const bm25 = deps.fts.search(input.q, 50).map(h => h.id)

  const [qVec] = await deps.embedder.embed([input.q])
  const semantic = await semanticSearch(deps.store, qVec!, 50)

  const fused = reciprocalRankFusion([bm25, semantic], 60).slice(0, limit * 2)

  const hits: QueryHit[] = []
  for (const f of fused) {
    const chunk = await deps.store.raw<{ c: { file_path: string; symbol_id: string; start_line: number; text: string } }>(
      `MATCH (c:Chunk {id: $id}) RETURN c`, { id: f.id }
    )
    if (chunk.length === 0) continue
    const c = chunk[0]!.c
    if (!c.symbol_id) continue
    const sym = await deps.store.raw<{ s: unknown }>(
      `MATCH (s:Symbol {id: $id}) RETURN s`, { id: c.symbol_id }
    )
    if (sym.length === 0) continue
    const s = sym[0]!.s as { id: string; name: string; kind: string; file_path: string; start_line: number; language: string }
    if (input.kinds && !input.kinds.includes(s.kind)) continue
    if (input.languages && !input.languages.includes(s.language)) continue
    hits.push({
      symbolId: s.id, name: s.name, kind: s.kind,
      filePath: s.file_path, line: s.start_line,
      snippet: c.text, score: f.score
    })
    if (hits.length >= limit) break
  }
  return hits
}

async function semanticSearch(store: GraphStore, qVec: number[], limit: number): Promise<string[]> {
  const rows = await store.raw<{ id: string; sim: number }>(
    `MATCH (c:Chunk)
     WITH c, gds.alpha.similarity.cosine(c.embedding, $q) AS sim
     RETURN c.id AS id, sim
     ORDER BY sim DESC LIMIT $lim`,
    { q: qVec, lim: limit }
  ).catch(async () => {
    // KuzuDB may not have GDS cosine — fall back to manual cosine over all chunks.
    const all = await store.raw<{ id: string; emb: number[] }>(
      `MATCH (c:Chunk) RETURN c.id AS id, c.embedding AS emb`
    )
    return all.map(r => ({ id: r.id, sim: cosine(qVec, r.emb) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, limit)
  })
  return rows.map(r => r.id)
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
