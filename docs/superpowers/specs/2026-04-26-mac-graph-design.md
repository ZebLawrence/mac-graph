# mac-graph — Design

**Status:** approved 2026-04-26
**Author:** Mac (with Zeb)
**Origin:** clean-room MVP inspired by [GitNexus](https://github.com/abhigyanpatwari/GitNexus). Implementation must not read GitNexus source code.

## 1. Goal

A self-hosted code-intelligence service for a single TypeScript-stack repository. Indexes the codebase into a knowledge graph, exposes that graph to AI agents (Claude Code et al.) over MCP, and provides a wiki + interactive visualizer over the same data.

The license posture is the point: **fully Apache-2.0 / MIT components**, suitable for use on commercial codebases where PolyForm-Noncommercial-licensed alternatives are not.

### Scope picks (from brainstorming, 2026-04-26)

- **Languages:** TypeScript (covers `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`), HTML, CSS, JSON.
- **Cross-language depth:** TypeScript via SCIP — full graph. HTML/CSS/JSON via tree-sitter — graph nodes only, **no cross-language edges to TS**.
- **MCP transport:** Streamable HTTP at `http://localhost:3030/mcp`.
- **Embeddings:** in-process via `transformers.js`, CPU-only. Default model: `Xenova/bge-small-en-v1.5` (384-dim).
- **Indexing trigger:** manual via HTTP POST + matching MCP tool. No file watcher.
- **Repo access:** read-only bind mount at `/repo`.
- **Wiki output:** files-on-disk in a writable bind mount **and** served over HTTP.
- **Visualizer:** Lit single-page app, vendored Cytoscape.js, served at `/viz`.
- **Out of scope (MVP):** multi-repo support, signed images, file watcher, raw `cypher` MCP tool, source-mutating tools (`rename`).

## 2. Architecture

One Docker container, one Node process, one repo's index.

```
~/projects/some-app                 (read-only, source code)
~/projects/some-app/.mac-graph-wiki (writable, output)
~/projects/some-app/.mac-graph-data (writable, KuzuDB + SQLite)
        │
        ▼ bind-mounts ▼
┌─ docker container (mac-graph:latest) ─────────────────┐
│   /repo (ro)   /wiki (rw)   /data (rw)                │
│                                                       │
│   ┌─ single Node process (Hono) ─────────────────┐    │
│   │  HTTP routes              MCP server         │    │
│   │   POST /index              Streamable HTTP   │    │
│   │   POST /index/incremental  at /mcp           │    │
│   │   GET  /index/status/:id   Tools:            │    │
│   │   POST /wiki/regenerate     query            │    │
│   │   GET  /graph               context          │    │
│   │   GET  /wiki/*              impact           │    │
│   │   GET  /viz                 detect_changes   │    │
│   │   GET  /health              reindex          │    │
│   └───────────────────────────────────────────────┘   │
│                                                       │
│   KuzuDB (embedded)        SQLite + FTS5              │
│   /data/kuzu/              /data/fts.db               │
│                                                       │
│   transformers.js (in-process, CPU), bge-small-en-v1.5│
│                                                       │
│   port 3030, bound to 127.0.0.1                       │
└───────────────────────────────────────────────────────┘
```

**Key shape decisions:**

- One container instance per indexed repo. Multi-repo = multi-container, different ports.
- Single Node process; no supervisor. The process is the indexer worker, the API, and the MCP server. They share the embedded DB handle in-memory.
- HTTP server binds `127.0.0.1` only by default. Setting `BIND_ALL=1` opens it on `0.0.0.0`. No auth in MVP, since localhost-only.
- KuzuDB and SQLite are both embedded — no extra services in the container.
- Writes are serialized: an index run takes a write lock. Reads continue against the previous committed snapshot via KuzuDB MVCC and atomically flip on writer commit.
- Process exits cleanly on SIGTERM so `docker stop` is fast.

## 3. Indexing pipeline

`POST /index` runs five phases:

### Phase 1 — Source enumeration

Walk `/repo` respecting `.gitignore` plus a `.mac-graph-ignore` overlay (same syntax). Collect candidate files by extension:

| Extension | Indexer | Treated as |
|---|---|---|
| `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` | `scip-typescript` | TS-graph (full SCIP) |
| `.html` `.htm` | `tree-sitter-html` | HTML-graph (file + symbols, no TS edges) |
| `.css` `.scss` | `tree-sitter-css` | CSS-graph (file + selectors) |
| `.json` | `tree-sitter-json` | JSON-graph (file + top-level keys) |
| anything else | text-only | FTS-only, no graph node |

### Phase 2 — TypeScript via SCIP

```
scip-typescript index --cwd /repo --output /tmp/index.scip
```

Parse the SCIP protobuf and map into the KuzuDB schema (Section 5). Provides for free: every symbol's canonical position, cross-file definitions and references, the import graph, and type information.

If `tsconfig.json` is missing, synthesize a permissive default. If `scip-typescript` exits non-zero, fail loudly: `/index` returns 500 with stderr in the problem-detail body.

### Phase 3 — Tree-sitter for HTML / CSS / JSON

For each file, run the language's tree-sitter grammar and emit nodes:

- **HTML:** one node per `id`, per custom element name, per `<script src="...">` reference.
- **CSS:** one node per selector — class, id, custom property.
- **JSON:** one node per top-level key path (depth-1 only — going deeper explodes node count).

These are `Symbol` nodes with `language` and `kind`. **No edges** to TypeScript symbols.

### Phase 4 — Chunking for embeddings

For each file, chunk at symbol boundaries (function, class, top-level statement) with ~30-line max and ~5-line overlap. For HTML/CSS/JSON: whole-file chunks under 30 lines, otherwise sliding windows. Each chunk gets:

- File path + byte range
- Optional symbol ID (links chunk → graph node)
- Embedding vector (`bge-small-en-v1.5`, 384-dim)

### Phase 5 — Persist

Single transaction:

1. Truncate previous run's nodes/edges (full reindex) **or** delta-apply (incremental).
2. Insert into KuzuDB: `Symbol`, `File`, `DEFINES`, `REFERENCES`, `IMPORTS`, `CONTAINS` rows.
3. Insert into SQLite FTS5: chunk text + BM25 index.
4. Insert into KuzuDB sidecar: chunk-id ↔ embedding-vector (flat L2 index, brute force — fine up to ~50k chunks).
5. Write `/data/manifest.json` with `indexedAt`, `commitSha?`, `fileCount`, `symbolCount`, `schemaVersion`.

Rough estimate for a 50k-LOC TypeScript repo on a laptop CPU: **2–5 minutes**, dominated by SCIP indexing (~60%) and embeddings (~30%).

### Incremental indexing

`POST /index/incremental` body: `{ "changedPaths": ["src/foo.ts", "src/bar.css"] }`. Re-run SCIP scoped to changed TS files, re-tree-sit changed HTML/CSS/JSON, re-chunk + re-embed only those files, surgically delete + reinsert their rows. Roughly 10–20× faster than full reindex on small change sets.

## 4. Embedding strategy

- **Provider:** `transformers.js` in-process, CPU-only.
- **Default model:** `Xenova/bge-small-en-v1.5`, 384-dim, ~33MB on disk, ~22ms/chunk on M1 CPU.
- **Loaded once** at process start. Process refuses to become healthy until model is loaded.
- **Model is configurable** via env `EMBEDDING_MODEL`. Any `transformers.js`-compatible sentence-embedding model works; schema's `Chunk.embedding FLOAT[384]` will need a migration if dim changes.

## 5. Graph schema (KuzuDB)

### Node tables

```cypher
NODE TABLE File (
  path        STRING PRIMARY KEY,    // repo-relative, POSIX
  language    STRING,                // 'ts'|'js'|'html'|'css'|'json'|'other'
  sha         STRING,                // git blob sha at index time
  size_bytes  INT64,
  loc         INT32                  // newline count
)

NODE TABLE Symbol (
  id          STRING PRIMARY KEY,    // SCIP symbol str for TS, synthetic for others
  name        STRING,                // 'foo', '#login-form', '.btn-primary'
  kind        STRING,                // 'function'|'class'|'method'|'interface'|
                                     // 'type'|'variable'|'html-id'|'css-class'|
                                     // 'css-id'|'css-var'|'json-key'|'custom-element'
  language    STRING,
  file_path   STRING,
  start_line  INT32,
  start_col   INT32,
  end_line    INT32,
  end_col     INT32,
  signature   STRING,                // for callables: '(a: number, b: string) => Foo'
  doc         STRING,                // leading JSDoc / docstring if any
  cluster_id  STRING                 // Leiden cluster, '' if not clustered yet
)

NODE TABLE Chunk (
  id          STRING PRIMARY KEY,    // file_path + ':' + start_line + '-' + end_line
  file_path   STRING,
  start_line  INT32,
  end_line    INT32,
  text        STRING,                // raw chunk content
  symbol_id   STRING,                // optional, '' if not bound to a symbol
  embedding   FLOAT[384]             // bge-small-en-v1.5
)

NODE TABLE Module (                  // import-graph node
  specifier   STRING PRIMARY KEY,    // './foo' resolved to 'src/foo.ts', or 'react'
  is_external BOOLEAN
)

NODE TABLE WikiPage (
  slug        STRING PRIMARY KEY,
  title       STRING,
  kind        STRING,                // 'symbol'|'file'|'cluster'|'overview'
  generated_at TIMESTAMP
)
```

### Relationship tables

```cypher
REL TABLE CONTAINS    (FROM File   TO Symbol)
REL TABLE DEFINES     (FROM Symbol TO Symbol)
REL TABLE REFERENCES  (FROM Symbol TO Symbol,
                       kind STRING,             // 'call'|'type-ref'|'extends'|'implements'|'read'|'write'
                       ref_line INT32,
                       ref_col  INT32)
REL TABLE IMPORTS     (FROM File   TO Module,
                       imported_names STRING[])
REL TABLE EXPORTS     (FROM File   TO Symbol)
REL TABLE CHUNKS      (FROM File   TO Chunk)
REL TABLE DOCUMENTS   (FROM WikiPage TO Symbol)
```

### Deliberate non-features

- **No call-graph reduction node.** Call chains are computed via Cypher path queries on `REFERENCES{kind:'call'}` at query time. Caching is a phase-2 optimization.
- **No clustering pre-compute table.** Leiden runs at index time over the `REFERENCES` graph and writes `cluster_id` directly on `Symbol`.
- **No language-specific subtype tables.** Everything is `Symbol` with a `kind` string.
- **No history.** Each reindex truncates + replaces.

### Capacity sanity check

For a 100k-LOC TypeScript codebase: ~8k Symbol nodes, ~25k REFERENCES edges, ~2k File nodes, ~12k Chunk nodes. KuzuDB embedded handles this in <1GB RAM with sub-10ms query latency for impact / context.

## 6. MCP tools

Five tools, served over Streamable HTTP. All return structured JSON; the agent formats prose.

### `query` — hybrid search

```ts
query(input: {
  q: string,
  limit?: number,               // default 10
  kinds?: SymbolKind[],
  languages?: Language[]
}) => {
  results: {
    symbol_id: string,
    name: string,
    kind: string,
    file_path: string,
    line: number,
    snippet: string,            // ±5 lines around the symbol
    score: number               // RRF-fused
  }[]
}
```

Implementation: BM25 over SQLite-FTS5 chunks + cosine over `Chunk.embedding`. Fuse with reciprocal rank: `score = Σ 1/(k+rank)`, `k=60`. Map chunks → symbols, dedupe, return top N.

### `context` — 360° view of a symbol

```ts
context(input: {
  symbol_id?: string,
  name?: string,                // resolves via fuzzy + 'kind' filter if given
  kind?: SymbolKind,
  depth?: number                // default 1, max 3
}) => {
  symbol: { id, name, kind, file_path, start_line, end_line, signature, doc },
  defined_in: { file_path, language },
  source: string,               // raw source of symbol's range
  imports: { module: string, imported_names: string[] }[],
  defines: Symbol[],            // children
  callers: { symbol: Symbol, ref_line: number }[],
  callees: { symbol: Symbol, ref_line: number }[],
  type_refs: { symbol: Symbol, ref_line: number }[],
  same_cluster: Symbol[]        // up to 8
}
```

Single Cypher query with `OPTIONAL MATCH` legs. Source body fetched from disk via the symbol's range.

### `impact` — blast radius of changing X

```ts
impact(input: {
  symbol_id: string,
  hops?: number                 // default 2, max 4
}) => {
  symbol: Symbol,
  direct_callers: { symbol, file_path, ref_line }[],
  transitive_callers: { symbol, depth: number, paths: PathString[] }[],
  type_consumers: Symbol[],     // who declares variables of this type
  files_affected: string[],
  tests_affected: string[]      // subset matching /\.(test|spec)\./
}
```

Cypher: `MATCH (target:Symbol {id:$id})<-[:REFERENCES*1..$hops {kind:'call'}]-(caller)` with path tracking.

`tests_affected` is the highest-leverage field for Claude Code: it directly answers "which tests should I run after this change."

### `detect_changes` — what's drifted since last index

```ts
detect_changes() => {
  manifest: { indexedAt, commitSha?, fileCount, symbolCount },
  changed_files: { path: string, status: 'modified'|'added'|'deleted' }[],
  index_stale: boolean
}
```

Walk `/repo`, sha each candidate file, compare against `File.sha` in KuzuDB. Doesn't require git.

### `reindex` — trigger an indexing run from inside a session

```ts
reindex(input: {
  mode?: 'full'|'incremental',  // default 'incremental'
  paths?: string[]              // required if mode='incremental'
}) => {
  status: 'started'|'busy',
  job_id: string,
  estimate_ms: number
}
```

Returns immediately. HTTP handler kicks off the work behind a write lock; status is pollable via `GET /index/status/:job_id`. If a run is already in flight, returns `busy` with the existing `job_id`.

### Excluded tools

- **`cypher` raw query.** Powerful but a footgun; lets the agent hammer the DB with malformed queries. Skipping in MVP.
- **`rename`.** Writes back into source code. Violates the read-only mount.

## 6.1. HTTP-only routes (not MCP tools)

A few routes exist for the visualizer and ops, not for agents:

- `GET /graph?center=<symbol_id>&hops=<n>&kinds=<csv>&languages=<csv>` — returns a subgraph as Cytoscape-compatible JSON (`{ nodes: [...], edges: [...] }`). Defaults: `hops=1`, no filters. Capped at 500 nodes server-side; over the cap, the response includes a `truncated: true` flag and the visualizer prompts the user to narrow the query.
- `GET /index/status/:job_id` — polled by the visualizer's "reindex" button after `reindex` returns `started`. Returns `{ phase, progress: 0..1, started_at, ended_at?, error? }`.
- `POST /wiki/regenerate` — body `{ scope?: 'all'|'symbol'|'cluster', target?: string }`. Triggers wiki-only regeneration without re-running the indexer.
- `GET /health` — described in §11.

## 7. Wiki generation

**Trigger.** Final phase of `POST /index?withWiki=true`, or independently via `POST /wiki/regenerate`. Opt-in because it requires an LLM call and burns tokens.

**What gets a page** (configurable thresholds):

- Every Leiden cluster with >3 symbols → cluster overview page.
- Every "important symbol" — exported AND (≥3 callers OR has JSDoc/docstring).
- One `index.md` table of contents.
- One file page per source file listing its symbols.

**Page shape:**

```markdown
---
symbol_id: scip-typescript ...
name: foo
kind: function
file: src/foo.ts
generated_at: 2026-04-26T17:30:00Z
---

# foo

> One-line summary, LLM-generated from signature + body.

## Signature
`(a: number, b: string) => Promise<Foo>`

## Description
Multi-paragraph LLM-generated description grounded in the source body.

## Used by
- [`bar`](../symbols/bar.md) — src/bar.ts:42

## Calls
- [`fetch`](...) — external
- [`parseFoo`](../symbols/parseFoo.md)

## Related symbols (cluster)
- [`fooHelper`](../symbols/fooHelper.md)
- [`FooConfig`](../symbols/FooConfig.md)
```

**LLM provider.** Pluggable, configured via env vars:

- `LLM_PROVIDER=anthropic|openai|ollama|http-webhook|none`
- Provider-specific config: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_URL` + `OLLAMA_MODEL`, or `WEBHOOK_URL` + a small request-shape adapter.

`none` means no LLM-generated descriptions; structural sections (signature, used-by, calls, related) still fill in. Useful fallback for offline / air-gapped setups.

The provider abstraction is a single `interface LLM { complete(prompt: string): Promise<string> }`. Adding a new provider is one file in `src/wiki/providers/`.

**Layout on disk:**

```
/wiki/
├── index.md
├── clusters/
│   ├── 001-auth-flow.md
│   └── 002-graph-builder.md
├── symbols/
│   ├── foo.md
│   └── parseFoo.md
└── files/
    └── src/foo.ts.md
```

Same content served at `GET /wiki/<path>` — markdown rendered to HTML by the server, raw markdown available at `?format=raw`.

## 8. Visualizer

**Stack.** Single-page Lit app, vendored Cytoscape.js, served at `GET /viz`. ~300 lines of Lit, no build step beyond a `tsc` compile.

**Layout (three panels):**

```
┌─ search bar ──────────────────────────────────────────┐
│ [ search… ] [language v] [kind v] [reindex] [refresh] │
├─ graph canvas ──────────────────────┬─ side panel ────┤
│                                     │  symbol details │
│   Cytoscape rendering of subgraph   │  signature      │
│   - nodes colored by language       │  callers        │
│   - edge weight by ref count        │  callees        │
│                                     │  cluster mates  │
│                                     │  → wiki link    │
│                                     │  → source line  │
└─────────────────────────────────────┴─────────────────┘
```

**Interactions:**

- Search box → `query` call → result list under search bar.
- Click a result → graph centers on that symbol's neighborhood (1-hop expanded by default, "+" button expands further).
- Click a graph node → side panel populated via `context`.
- Side-panel "Impact" toggle → re-renders graph as the `impact` blast radius (1–3 hops outbound from "what calls this").
- Side-panel "Open wiki" → navigates to `/wiki/symbols/<id>` if a page exists.

**Non-features (MVP):** no editing, no saving views, no GitHub-style file browser.

**Performance ceiling.** Cytoscape comfortably renders ~2k nodes / ~5k edges at 60fps. The viz never loads the whole graph — every interaction asks the server for a small subgraph bounded by hop count.

## 9. Error handling

**HTTP errors** follow [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457):

```json
{
  "type": "https://mac-graph/errors/scip-failed",
  "title": "scip-typescript exited non-zero",
  "status": 500,
  "detail": "tsc TS2307: ...",
  "instance": "/index",
  "job_id": "ix_01H..."
}
```

**MCP errors** use the JSON-RPC error envelope. Tool-level "expected" failures (e.g. `context` with unknown `symbol_id`) return a structured `{ ok: false, reason: 'symbol_not_found' }` *result* rather than an RPC error, so the agent gets a clean signal to retry.

**Indexer failure modes:**

| Failure | Behavior |
|---|---|
| `scip-typescript` exits non-zero | Capture stderr; `/index` returns 500 with stderr in `detail`; partial graph from previous run remains queryable |
| Tree-sitter parse error on one file | Log warning, skip the file, continue; `/index` returns 200 with `warnings: [...]` |
| Embedding model fails to load | Server refuses to start; `/health` never becomes 200 |
| KuzuDB write lock contention | `reindex` returns `{status:'busy'}`; HTTP `/index` returns 409 with in-flight `job_id` |
| Out-of-disk during persist | Transaction rolls back; previous index intact; `/index` returns 507 |
| LLM call fails during wiki gen | Page generated with structural sections only; summary reads "(LLM unavailable)" |

## 10. Concurrency

- One write lock guards the indexer phases. Held for the whole `/index` run.
- Reads (MCP tools, `/graph`, `/wiki/*`) take KuzuDB read transactions — they see the previous committed state during a reindex, then atomically flip when the writer commits.
- `/health` is lock-free; reports `indexing: true|false`, manifest age, and queue depth.

## 11. Logging & observability

- Structured JSON logs to stdout via `pino`.
- Each `/index` run gets a `job_id` and emits start/phase/complete events.
- `/health` exposes process uptime, manifest `indexedAt`, KuzuDB row counts, embedding-model loaded boolean, in-flight job count.
- No metrics endpoint in MVP. Add Prometheus later if it ever runs in real prod.

## 12. Testing strategy

**Three tiers:**

1. **Unit** (`vitest`):
   - SCIP protobuf → KuzuDB row mapping (fixture: small SCIP file).
   - Tree-sitter ingest per language (fixture: hand-crafted HTML/CSS/JSON files).
   - Chunker symbol-boundary logic.
   - RRF fusion math.
   - Each MCP tool handler with a stubbed DB.

2. **Integration** (`vitest`, real KuzuDB + SQLite, no docker):
   - Run full pipeline against `fixtures/sample-app/` — a ~20-file mini Express app with Lit components, CSS, and a JSON config.
   - Assert specific Cypher results: known callers, known impact set, known cluster membership.
   - Snapshot tests on MCP tool JSON responses.

3. **End-to-end** (`vitest` + `dockerode`):
   - `docker build`, `docker run`, hit endpoints over HTTP/MCP, assert.
   - One test per MCP tool, one per HTTP route, one full `/index` cycle.
   - Runs on CI; skipped locally unless `E2E=1`.

**Coverage target:** 80% line coverage for `src/`, no coverage gate on `e2e/`. A green CI run is the merge gate.

## 13. Versioning & releases

- Semver on the docker image tag: `mac-graph:0.1.0`, `mac-graph:latest`.
- KuzuDB schema migrations live in `src/migrations/NNN-description.ts`. On startup, the process reads `/data/manifest.json#schemaVersion` and runs missing migrations forward. No down migrations in MVP — old DBs that fall behind are nuked + reindexed.
- No signed images. Plain `docker build && docker push` to GHCR.

## 14. Dev workflow

```bash
# inside ~/projects/mac-graph
pnpm install
pnpm dev       # tsx watch, no docker, KuzuDB at .dev/data/
pnpm test      # unit + integration
pnpm test:e2e  # builds image, spins container

pnpm docker:build
pnpm docker:run -- /path/to/repo
```

`pnpm docker:run` is a thin wrapper that bind-mounts the target repo at `/repo:ro`, creates `.mac-graph-data/` and `.mac-graph-wiki/` in the cwd, and starts the container on port 3030.

## 15. Repo layout

```
~/projects/mac-graph/
├── README.md
├── Dockerfile
├── package.json
├── tsconfig.json
├── src/
│   ├── server.ts         (Hono entry)
│   ├── mcp/              (MCP server + tools)
│   ├── indexer/
│   │   ├── scip.ts
│   │   ├── treesitter.ts
│   │   ├── chunker.ts
│   │   └── embed.ts
│   ├── store/
│   │   ├── kuzu.ts
│   │   └── fts.ts
│   ├── search/           (RRF, query)
│   ├── wiki/
│   ├── viz/              (Lit app, served as static)
│   └── migrations/
├── fixtures/sample-app/
├── tests/
└── e2e/
```

## 16. Legal note (clean-room)

This project is a clean-room reimagining inspired by the *external* description of GitNexus (its README, public docs, MCP tool surface). To preserve the Apache-2.0 / MIT licensing posture of the components below, **implementation must not consult GitNexus source code**. Specs and behavior come from the outside; implementation goes against the spec.

All third-party components are explicitly permissively licensed:

| Component | License |
|---|---|
| `scip-typescript` | Apache-2.0 |
| KuzuDB | MIT |
| `tree-sitter` + grammars | MIT |
| `transformers.js` | Apache-2.0 |
| Hono | MIT |
| Lit | BSD-3-Clause |
| Cytoscape.js | MIT |
| `pino` | MIT |
| `vitest` | MIT |
| `dockerode` | Apache-2.0 |

The mac-graph project itself ships under MIT.
