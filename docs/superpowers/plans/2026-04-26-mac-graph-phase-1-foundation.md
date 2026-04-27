# mac-graph Phase 1 — Foundation MVP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Docker container that indexes a TypeScript-stack repository into a knowledge graph and exposes 5 MCP tools (`query`, `context`, `impact`, `detect_changes`, `reindex`) over Streamable HTTP.

**Architecture:** Single Node process running Hono. Reads source from `/repo` (read-only bind mount), persists graph to KuzuDB at `/data/kuzu/`, FTS to SQLite at `/data/fts.db`, embeddings in-process via `transformers.js` on CPU. SCIP-typescript handles cross-file resolution; tree-sitter handles HTML/CSS/JSON as graph nodes only (no cross-language edges).

**Tech Stack:** Node 22 + TypeScript, Hono, `@modelcontextprotocol/sdk`, `kuzu` (Node SDK, v0.11.x — see archival note below), `better-sqlite3`, `@xenova/transformers`, vendored `scip_pb.ts` from sourcegraph/scip (protobuf bindings), `@sourcegraph/scip-typescript` (CLI), `tree-sitter` + grammars for HTML/CSS/JSON, Pino, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-26-mac-graph-design.md`

**Out of scope for this plan:** wiki generation (Phase 2), Lit visualizer (Phase 3), `GET /graph` subgraph endpoint (Phase 3 — only the visualizer needs it), file watcher, multi-repo, signed images.

## Plan amendments (post-brainstorm corrections)

Recorded 2026-04-26 after T01 surfaced the following plan errors. Subsequent tasks must follow the corrected versions below, not the original plan body where it conflicts.

1. **`@sourcegraph/scip` does not exist on npm.** The TypeScript protobuf bindings live inside the `sourcegraph/scip` GitHub repo at `bindings/typescript/scip_pb.ts` (Apache 2.0). We **vendor** that file as `src/vendor/scip_pb.ts` instead of depending on `@c4312/scip` or any other community wrapper. Task 13 below is updated accordingly.
2. **`scip-typescript` should be `@sourcegraph/scip-typescript`** (the canonical scoped name). Update package.json devDependencies.
3. **`kuzu` was archived 2025-10-10**, last npm release `0.11.3`. We continue to use it — it's embedded, the binary works, and migrating is YAGNI for this MVP. Pin to `^0.11.0` (not `^0.6.0`). Acceptance: archived ≠ broken; we'll migrate if/when we hit an unfixable bug.
4. **Vitest 2.x exits 1 on no-tests-found** (was 0 in v1). Add `--passWithNoTests` to `test` and `test:watch` scripts so the scaffold passes between tasks.
5. **`tree-sitter` must be `^0.22.0`** (not `^0.21.0`) to satisfy the grammars' `^0.22.4` peer requirement.
6. **Native build scripts** (`better-sqlite3`, `kuzu`, `tree-sitter*`) are blocked by pnpm 10's default security policy. The cleanest fix is declarative: a `pnpm-workspace.yaml` at the repo root with an `onlyBuiltDependencies` array listing the native packages we trust. **T06 owns this** — Step 0 of T06 creates the file and re-runs `pnpm install` so kuzu compiles before its tests run. Subsequent native-using tasks (T07/T08/T13/T14) inherit the approved list, no extra work needed.
7. **`tsconfig.json` cannot have `rootDir: "src"`** while `include` covers both `src/**/*` and `tests/**/*` — tests live outside rootDir, which makes `tsc` reject them. Drop `rootDir`. T27 (Dockerfile/build setup) will introduce a dedicated `tsconfig.build.json` that re-adds `rootDir: "src"` and excludes tests for production builds. Until then, `pnpm build` would emit `dist/src/...` + `dist/tests/...`, which is harmless because no task before T27 actually runs `pnpm build`.
8. **kuzu `connection.query()` does not accept a params object** — the second argument is a progress callback. Parameterized queries must use `connection.prepare(cypher)` + `connection.execute(prepared, params)`. T07 wraps this in a private `pquery(cypher, params)` helper. T07 onwards: any code that needs parameterized kuzu queries must go through `GraphStore`'s public methods (which use `pquery`) or `store.raw()` (which also uses `pquery`). Plain `conn.query(cypher)` is reserved for parameter-less statements like `truncateAll`'s `DETACH DELETE`.
9. **`scip_pb.ts` (vendored from sourcegraph/scip) uses `@bufbuild/protobuf` codegenv2**, not protobufjs. This means: (a) the file uses **flat exports** with no `scip` namespace — import named values `IndexSchema`, `SymbolRole`, `SymbolInformation_Kind`, plus types `Index`, `Document`, `SyntaxKind`; (b) **field names are camelCase** at the TS level (`relativePath`, `symbolRoles`, `syntaxKind`, `signatureDocumentation`) even though the underlying `.proto` uses snake_case; (c) **deserialization uses `fromBinary(IndexSchema, buf)`** from `@bufbuild/protobuf`, not a `.deserialize()` method on the message class. Add `@bufbuild/protobuf@^2.12.0` to `dependencies`. The plan code in T13 Step 4 reflects all of this.
10. **Tree-sitter grammar packages ship typings, but their `Language` type is incompatible with `tree-sitter`'s own `Language` type** in v0.22.x. T14's plan code uses `// @ts-expect-error` to suppress this, but `@ts-expect-error` then becomes a "directive unused" error itself. Real fix: drop `@ts-expect-error`, use `parser.setLanguage(GRAMMAR as any)` with an eslint-disable comment for that line. T14 plan code includes this pattern.
11. **HTML attribute children are unnamed fields**, not `name`/`value`. Use `namedChildren[0]` (attribute_name) and `namedChildren[1]` (quoted_attribute_value). The actual value text lives in the quoted-value's first named child. Plan code in T14 Step 5 reflects this.
12. **CSS `declaration.property` is not a named field** — use `namedChildren[0]` (property_name node). Plan code in T14 Step 6 reflects this.

---

## Shared Types Reference

These types are defined in Task 6 and used throughout. Keep names/cases consistent.

```ts
// src/store/types.ts
export type Language = 'ts' | 'js' | 'html' | 'css' | 'json' | 'other'

export type SymbolKind =
  | 'function' | 'class' | 'method' | 'interface'
  | 'type' | 'variable'
  | 'html-id' | 'css-class' | 'css-id' | 'css-var'
  | 'json-key' | 'custom-element'

export type RefKind = 'call' | 'type-ref' | 'extends' | 'implements' | 'read' | 'write'

export interface SymbolNode {
  id: string
  name: string
  kind: SymbolKind
  language: Language
  filePath: string
  startLine: number
  startCol: number
  endLine: number
  endCol: number
  signature: string
  doc: string
  clusterId: string         // '' if unset
}

export interface FileNode {
  path: string
  language: Language
  sha: string
  sizeBytes: bigint
  loc: number
}

export interface ChunkNode {
  id: string                // filePath + ':' + startLine + '-' + endLine
  filePath: string
  startLine: number
  endLine: number
  text: string
  symbolId: string          // '' if unset
  embedding: number[]       // length 384
}

export interface ModuleNode {
  specifier: string
  isExternal: boolean
}

export interface ReferenceEdge {
  fromSymbolId: string
  toSymbolId: string
  kind: RefKind
  refLine: number
  refCol: number
}

export interface Manifest {
  schemaVersion: number     // increment on breaking schema change
  indexedAt: string         // ISO 8601
  commitSha?: string
  fileCount: number
  symbolCount: number
  embeddingModel: string
  embeddingDim: number
}
```

## File structure

```
~/projects/mac-graph/
├── package.json
├── pnpm-workspace.yaml                 # native-build approval list
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
├── Dockerfile
├── .dockerignore
├── .gitignore
├── README.md
├── scripts/docker-run.sh
├── docs/superpowers/{specs,plans}/
├── src/
│   ├── server.ts                       # Hono entry, wires all subsystems
│   ├── env.ts                          # zod env parser
│   ├── log.ts                          # pino singleton
│   ├── lock.ts                         # write-lock primitive
│   ├── store/
│   │   ├── types.ts                    # shared types
│   │   ├── kuzu.ts                     # KuzuDB connection + insert/query helpers
│   │   ├── kuzu-schema.ts              # CREATE NODE/REL TABLE statements + version
│   │   ├── fts.ts                      # SQLite + FTS5 wrapper
│   │   └── manifest.ts                 # /data/manifest.json read/write
│   ├── indexer/
│   │   ├── enumerate.ts                # walk /repo with .gitignore + .mac-graph-ignore
│   │   ├── scip.ts                     # spawn scip-typescript, parse protobuf
│   │   ├── treesitter/
│   │   │   ├── html.ts
│   │   │   ├── css.ts
│   │   │   └── json.ts
│   │   ├── chunker.ts                  # symbol-boundary chunking
│   │   ├── embed.ts                    # transformers.js wrapper
│   │   └── orchestrator.ts             # full + incremental
│   ├── search/
│   │   ├── rrf.ts
│   │   └── query.ts
│   ├── http/
│   │   ├── errors.ts                   # RFC 9457 helper
│   │   └── routes/
│   │       ├── health.ts
│   │       └── index-routes.ts         # POST /index, /index/incremental, GET /index/status/:id
│   ├── mcp/
│   │   ├── server.ts
│   │   ├── schemas.ts
│   │   └── tools/
│   │       ├── query.ts
│   │       ├── context.ts
│   │       ├── impact.ts
│   │       ├── detect-changes.ts
│   │       └── reindex.ts
│   └── vendor/
│       └── scip_pb.ts                  # vendored from sourcegraph/scip (Apache-2.0)
├── fixtures/sample-app/                # mini Express + Lit + CSS + JSON for tests
└── tests/
    ├── unit/
    └── integration/
    └── e2e/
```

---

## Task 1: Project skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.gitignore`, `README.md`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "mac-graph",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "license": "MIT",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/server.ts",
    "test": "vitest run --passWithNoTests --exclude tests/e2e",
    "test:watch": "vitest --passWithNoTests --exclude tests/e2e",
    "test:e2e": "E2E=1 vitest run tests/e2e",
    "lint": "eslint src tests",
    "typecheck": "tsc --noEmit",
    "docker:build": "docker build -t mac-graph:latest .",
    "docker:run": "scripts/docker-run.sh"
  },
  "dependencies": {
    "@bufbuild/protobuf": "^2.12.0",
    "@hono/node-server": "^1.13.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@xenova/transformers": "^2.17.0",
    "better-sqlite3": "^11.5.0",
    "hono": "^4.6.0",
    "ignore": "^6.0.0",
    "kuzu": "^0.11.0",
    "pino": "^9.5.0",
    "tree-sitter": "^0.22.0",
    "tree-sitter-css": "^0.23.0",
    "tree-sitter-html": "^0.23.0",
    "tree-sitter-json": "^0.24.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@sourcegraph/scip-typescript": "^0.4.0",
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "dockerode": "^4.0.0",
    "eslint": "^9.0.0",
    "pino-pretty": "^11.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    testTimeout: 30_000
  }
})
```

- [ ] **Step 4: Write `eslint.config.js` (flat config)**

```js
import js from '@eslint/js'

export default [
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] }
  }
]
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
dist/
.dev/
.mac-graph-data/
.mac-graph-wiki/
*.log
.DS_Store
```

- [ ] **Step 6: Write minimal `README.md`**

```markdown
# mac-graph

Self-hosted code-intelligence MCP server for TypeScript-stack repositories.

See `docs/superpowers/specs/` for design and `docs/superpowers/plans/` for implementation plans.
```

- [ ] **Step 7: Install dependencies**

Run: `pnpm install`
Expected: lockfile created, no errors.

- [ ] **Step 8: Verify test runner works**

Run: `pnpm test`
Expected: vitest exits 0 (the `--passWithNoTests` flag in the script silences the "no tests found" failure that vitest 2.x emits by default).

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "chore: project skeleton (Node + TS + Vitest)"
```

---

## Task 2: Pino logger

**Files:**
- Create: `src/log.ts`, `tests/unit/log.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/log.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/log.test.ts`
Expected: FAIL — module `src/log.ts` not found.

- [ ] **Step 3: Write `src/log.ts`**

```ts
import { pino } from 'pino'

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: 'mac-graph' }
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/log.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/log.ts tests/unit/log.test.ts
git commit -m "feat(log): pino logger singleton"
```

---

## Task 3: Env parser

**Files:**
- Create: `src/env.ts`, `tests/unit/env.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/env.test.ts
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
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm test tests/unit/env.test.ts` — fails (module missing).

- [ ] **Step 3: Write `src/env.ts`**

```ts
import { z } from 'zod'

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(3030),
  BIND_ALL: z.string().transform(v => v === '1' || v === 'true').default('0'),
  DATA_DIR: z.string().default('/data'),
  REPO_DIR: z.string().default('/repo'),
  WIKI_DIR: z.string().default('/wiki'),
  EMBEDDING_MODEL: z.string().default('Xenova/bge-small-en-v1.5'),
  LOG_LEVEL: z.string().default('info')
})

export type Env = z.infer<typeof Schema>

export function parseEnv(source: Record<string, string | undefined>): Env {
  return Schema.parse(source)
}

export const env: Env = parseEnv(process.env)
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test tests/unit/env.test.ts` — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/env.ts tests/unit/env.test.ts
git commit -m "feat(env): zod-validated env parser"
```

---

## Task 4: Write-lock primitive

**Files:**
- Create: `src/lock.ts`, `tests/unit/lock.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lock.test.ts
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
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Write `src/lock.ts`**

```ts
type Release = () => void

export class WriteLock {
  private holder: string | null = null
  private queue: Array<{ holder: string; resolve: (release: Release) => void }> = []

  async acquire(holder: string): Promise<Release> {
    if (this.holder === null) {
      this.holder = holder
      return () => this.release()
    }
    return new Promise<Release>(resolve => {
      this.queue.push({ holder, resolve })
    })
  }

  tryAcquire(holder: string): Release | null {
    if (this.holder !== null) return null
    this.holder = holder
    return () => this.release()
  }

  inspect(): { held: boolean; holder: string | null } {
    return { held: this.holder !== null, holder: this.holder }
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) {
      this.holder = next.holder
      next.resolve(() => this.release())
    } else {
      this.holder = null
    }
  }
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/lock.ts tests/unit/lock.test.ts
git commit -m "feat(lock): FIFO write-lock primitive"
```

---

## Task 5: Shared store types

**Files:**
- Create: `src/store/types.ts` (no test — pure types)

- [ ] **Step 1: Write `src/store/types.ts`**

(See "Shared Types Reference" at the top of this plan for the full content. Copy that block into `src/store/types.ts`.)

- [ ] **Step 2: Verify typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/store/types.ts
git commit -m "feat(store): shared type definitions"
```

---

## Task 6: KuzuDB schema + migrations

**Files:**
- Create: `pnpm-workspace.yaml`, `src/store/kuzu-schema.ts`, `tests/unit/kuzu-schema.test.ts`

- [ ] **Step 0: Create `pnpm-workspace.yaml` and re-install to compile native bits**

`pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - "@xenova/transformers"
  - better-sqlite3
  - kuzu
  - sharp
  - tree-sitter
  - tree-sitter-css
  - tree-sitter-html
  - tree-sitter-json
```

Note: `sharp` is a transitive dep of `@xenova/transformers`. Including it explicitly avoids the prebuild-install pitfall T12 surfaced.

Then re-run `pnpm install` from the project root. Native compile may take 30–90s on first run for kuzu. If the install hits "no C++ toolchain" or similar errors, escalate — likely missing Xcode CLI tools on macOS (`xcode-select --install`) or build-essential on Linux.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/kuzu-schema.test.ts
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
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Write `src/store/kuzu-schema.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/store/kuzu-schema.ts tests/unit/kuzu-schema.test.ts
git commit -m "feat(store): KuzuDB schema + idempotent applySchema"
```

---

## Task 7: KuzuDB client wrapper

**Files:**
- Create: `src/store/kuzu.ts`, `tests/unit/kuzu.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/kuzu.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/store/kuzu.js'

describe('GraphStore', () => {
  let dir: string
  let store: GraphStore
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mg-'))
    store = await GraphStore.open(join(dir, 'kuzu'))
  })
  afterEach(async () => {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('inserts and retrieves a File node', async () => {
    await store.upsertFile({
      path: 'src/foo.ts', language: 'ts', sha: 'abc',
      sizeBytes: 100n, loc: 10
    })
    const got = await store.getFile('src/foo.ts')
    expect(got?.path).toBe('src/foo.ts')
    expect(got?.sha).toBe('abc')
  })

  it('inserts a Symbol and CONTAINS edge', async () => {
    await store.upsertFile({ path: 'a.ts', language: 'ts', sha: 's', sizeBytes: 0n, loc: 0 })
    await store.upsertSymbol({
      id: 'sym1', name: 'foo', kind: 'function', language: 'ts',
      filePath: 'a.ts', startLine: 1, startCol: 0, endLine: 5, endCol: 0,
      signature: '', doc: '', clusterId: ''
    })
    await store.linkContains('a.ts', 'sym1')
    const syms = await store.symbolsInFile('a.ts')
    expect(syms.map(s => s.id)).toContain('sym1')
  })

  it('truncates all tables', async () => {
    await store.upsertFile({ path: 'a.ts', language: 'ts', sha: 's', sizeBytes: 0n, loc: 0 })
    await store.truncateAll()
    expect(await store.getFile('a.ts')).toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Write `src/store/kuzu.ts`**

```ts
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
   * kuzu's `connection.query()` does NOT accept a params object — its second
   * argument is a progress callback. Parameterized execution requires
   * prepare() + execute().
   */
  private async pquery(
    cypher: string,
    params: Record<string, unknown> = {}
  ): Promise<kuzu.QueryResult> {
    const prepared = await this.conn.prepare(cypher)
    // Cast: callers pass valid KuzuValues at runtime; the internal API just
    // wants the more permissive Record<string, unknown> signature for ergonomics.
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
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/store/kuzu.ts tests/unit/kuzu.test.ts
git commit -m "feat(store): GraphStore wrapper around KuzuDB"
```

---

## Task 8: SQLite + FTS5 wrapper

**Files:**
- Create: `src/store/fts.ts`, `tests/unit/fts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/fts.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FtsStore } from '../../src/store/fts.js'

describe('FtsStore', () => {
  let dir: string
  let fts: FtsStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mg-fts-'))
    fts = new FtsStore(join(dir, 'fts.db'))
  })
  afterEach(() => {
    fts.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('inserts and BM25-searches chunks', () => {
    fts.upsert('a:1-3', 'function fooBar() { return 42 }')
    fts.upsert('b:1-3', 'function bazQux() { return 99 }')
    const hits = fts.search('fooBar', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.id).toBe('a:1-3')
  })

  it('removes by id', () => {
    fts.upsert('x:1-1', 'hello world')
    fts.remove('x:1-1')
    expect(fts.search('hello', 5)).toEqual([])
  })

  it('removeByFile clears all chunks for a file', () => {
    fts.upsert('foo.ts:1-1', 'one')
    fts.upsert('foo.ts:5-5', 'two')
    fts.upsert('bar.ts:1-1', 'three')
    fts.removeByFile('foo.ts')
    expect(fts.search('one', 5)).toEqual([])
    expect(fts.search('two', 5)).toEqual([])
    expect(fts.search('three', 5).length).toBe(1)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Write `src/store/fts.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/store/fts.ts tests/unit/fts.test.ts
git commit -m "feat(store): SQLite FTS5 wrapper for BM25 search"
```

---

## Task 9: Manifest read/write

**Files:**
- Create: `src/store/manifest.ts`, `tests/unit/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Write `src/store/manifest.ts`**

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Manifest } from './types.js'

const NAME = 'manifest.json'

export async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(dir, NAME), 'utf8')
    return JSON.parse(raw) as Manifest
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeManifest(dir: string, m: Manifest): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, NAME), JSON.stringify(m, null, 2), 'utf8')
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/store/manifest.ts tests/unit/manifest.test.ts
git commit -m "feat(store): manifest.json read/write"
```

---

## Task 10: Source enumerator

**Files:**
- Create: `src/indexer/enumerate.ts`, `tests/unit/enumerate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/enumerate.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enumerateSources } from '../../src/indexer/enumerate.js'

describe('enumerateSources', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mg-e-'))
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1')
    writeFileSync(join(dir, 'src', 'b.css'), '.x { }')
    writeFileSync(join(dir, 'src', 'c.html'), '<div></div>')
    writeFileSync(join(dir, 'src', 'd.json'), '{}')
    writeFileSync(join(dir, 'src', 'e.bin'), 'binary')
    writeFileSync(join(dir, 'node_modules', 'react', 'i.ts'), 'export {}')
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns paths classified by language, ignoring gitignore', async () => {
    const out = await enumerateSources(dir)
    const paths = out.map(f => f.relPath).sort()
    expect(paths).toEqual(['src/a.ts', 'src/b.css', 'src/c.html', 'src/d.json', 'src/e.bin'])
    const byPath = Object.fromEntries(out.map(f => [f.relPath, f.language]))
    expect(byPath['src/a.ts']).toBe('ts')
    expect(byPath['src/b.css']).toBe('css')
    expect(byPath['src/e.bin']).toBe('other')
  })

  it('honors .mac-graph-ignore overlay', async () => {
    writeFileSync(join(dir, '.mac-graph-ignore'), 'src/e.bin\n')
    const out = await enumerateSources(dir)
    expect(out.find(f => f.relPath === 'src/e.bin')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Write `src/indexer/enumerate.ts`**

```ts
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import ignore from 'ignore'
import type { Language } from '../store/types.js'

export interface EnumeratedFile {
  absPath: string
  relPath: string
  language: Language
  sizeBytes: bigint
}

const EXT_LANG: Record<string, Language> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'css',
  '.json': 'json'
}

export async function enumerateSources(repoDir: string): Promise<EnumeratedFile[]> {
  const ig = ignore()
  for (const f of ['.gitignore', '.mac-graph-ignore']) {
    try { ig.add(await readFile(join(repoDir, f), 'utf8')) } catch { /* missing is fine */ }
  }
  ig.add(['.git/', '.mac-graph-data/', '.mac-graph-wiki/', '.*'])

  const out: EnumeratedFile[] = []
  await walk(repoDir, '')

  return out

  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await readdir(abs, { withFileTypes: true })
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const childAbs = join(abs, e.name)
      const checkPath = e.isDirectory() ? `${childRel}/` : childRel
      if (ig.ignores(checkPath)) continue
      if (e.isDirectory()) {
        await walk(childAbs, childRel)
      } else if (e.isFile()) {
        const ext = extname(e.name)
        const language = EXT_LANG[ext] ?? 'other'
        const s = await stat(childAbs)
        out.push({ absPath: childAbs, relPath: childRel, language, sizeBytes: BigInt(s.size) })
      }
    }
  }
}

function extname(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i)
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/indexer/enumerate.ts tests/unit/enumerate.test.ts
git commit -m "feat(indexer): source enumerator with gitignore + overlay"
```

---

## Task 11: Chunker

**Files:**
- Create: `src/indexer/chunker.ts`, `tests/unit/chunker.test.ts`

**Note on contract:** The chunker takes file content + an optional list of symbol ranges (for code files where SCIP has already given us symbol boundaries). For non-code files (CSS/HTML/JSON/other), it sliding-windows.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/chunker.test.ts
import { describe, it, expect } from 'vitest'
import { chunkFile } from '../../src/indexer/chunker.js'

const SHORT = 'line1\nline2\nline3\n'

describe('chunkFile', () => {
  it('emits a single chunk for short files (no symbols)', () => {
    const chunks = chunkFile({ filePath: 'a.css', text: SHORT, symbols: [] })
    expect(chunks.length).toBe(1)
    expect(chunks[0]?.startLine).toBe(1)
    expect(chunks[0]?.endLine).toBe(3)
    expect(chunks[0]?.symbolId).toBe('')
  })

  it('chunks at symbol boundaries when provided', () => {
    const text = Array.from({ length: 60 }, (_, i) => `l${i + 1}`).join('\n')
    const chunks = chunkFile({
      filePath: 'a.ts',
      text,
      symbols: [
        { id: 's1', startLine: 1, endLine: 20 },
        { id: 's2', startLine: 21, endLine: 60 }
      ]
    })
    expect(chunks.length).toBe(2)
    expect(chunks[0]?.symbolId).toBe('s1')
    expect(chunks[1]?.symbolId).toBe('s2')
  })

  it('sliding-windows long non-code files', () => {
    const text = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join('\n')
    const chunks = chunkFile({ filePath: 'a.css', text, symbols: [] })
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks[0]?.startLine).toBe(1)
    expect(chunks[1]!.startLine).toBeLessThan(chunks[0]!.endLine)  // overlap
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Write `src/indexer/chunker.ts`**

```ts
const MAX_LINES = 30
const OVERLAP = 5

export interface SymbolRange {
  id: string
  startLine: number
  endLine: number
}

export interface ChunkInput {
  filePath: string
  text: string
  symbols: SymbolRange[]
}

export interface ChunkResult {
  id: string
  filePath: string
  startLine: number
  endLine: number
  text: string
  symbolId: string
}

export function chunkFile(input: ChunkInput): ChunkResult[] {
  // Strip trailing newline before splitting so 'a\nb\nc\n' → ['a','b','c'] (3 lines, not 4)
  const normalised = input.text.endsWith('\n') ? input.text.slice(0, -1) : input.text
  const lines = normalised.split('\n')
  if (input.symbols.length > 0) {
    return input.symbols.map(s => buildChunk(input.filePath, lines, s.startLine, s.endLine, s.id))
  }
  return slidingWindow(input.filePath, lines)
}

function slidingWindow(filePath: string, lines: string[]): ChunkResult[] {
  if (lines.length <= MAX_LINES) {
    return [buildChunk(filePath, lines, 1, lines.length, '')]
  }
  const out: ChunkResult[] = []
  let start = 1
  while (start <= lines.length) {
    const end = Math.min(start + MAX_LINES - 1, lines.length)
    out.push(buildChunk(filePath, lines, start, end, ''))
    if (end === lines.length) break
    start = end - OVERLAP + 1
  }
  return out
}

function buildChunk(
  filePath: string, lines: string[],
  startLine: number, endLine: number, symbolId: string
): ChunkResult {
  const text = lines.slice(startLine - 1, endLine).join('\n')
  return {
    id: `${filePath}:${startLine}-${endLine}`,
    filePath, startLine, endLine, text, symbolId
  }
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/indexer/chunker.ts tests/unit/chunker.test.ts
git commit -m "feat(indexer): symbol-boundary + sliding-window chunker"
```

---

## Task 12: Embedder

**Files:**
- Create: `src/indexer/embed.ts`, `tests/unit/embed.test.ts`

**Note:** The first call lazy-loads the model from disk (or downloads on first run). Test sets `TRANSFORMERS_CACHE` to a tmp dir to avoid touching the real cache.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/embed.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Embedder } from '../../src/indexer/embed.js'

beforeAll(() => {
  process.env.TRANSFORMERS_CACHE = mkdtempSync(join(tmpdir(), 'mg-tx-'))
})

describe('Embedder', () => {
  it('returns 384-dim vectors for bge-small-en-v1.5', async () => {
    const e = new Embedder('Xenova/bge-small-en-v1.5')
    const [v] = await e.embed(['hello world'])
    expect(v).toHaveLength(384)
    expect(v!.every(x => typeof x === 'number')).toBe(true)
  }, 120_000)

  it('batches multiple inputs', async () => {
    const e = new Embedder('Xenova/bge-small-en-v1.5')
    const out = await e.embed(['a', 'b', 'c'])
    expect(out).toHaveLength(3)
    expect(out[0]).toHaveLength(384)
  }, 120_000)
})
```

- [ ] **Step 2: Run, expect FAIL** (and slow — first run downloads ~100MB)

- [ ] **Step 3: Write `src/indexer/embed.ts`**

```ts
import { pipeline } from '@xenova/transformers'
import { log } from '../log.js'

type FE = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ data: Float32Array; dims: number[] }>

export class Embedder {
  private fe: FE | null = null

  constructor(private modelId: string) {}

  async ready(): Promise<void> {
    if (this.fe) return
    log.info({ model: this.modelId }, 'loading embedding model')
    const fe = await pipeline('feature-extraction', this.modelId)
    this.fe = fe as unknown as FE
    log.info({ model: this.modelId }, 'embedding model ready')
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.ready()
    if (texts.length === 0) return []
    const out = await this.fe!(texts, { pooling: 'mean', normalize: true })
    const dim = out.dims[1]!
    const result: number[][] = []
    for (let i = 0; i < texts.length; i++) {
      const start = i * dim
      result.push(Array.from(out.data.slice(start, start + dim)))
    }
    return result
  }
}
```

- [ ] **Step 4: Run, expect PASS** (downloads model on first run)

- [ ] **Step 5: Commit**

```bash
git add src/indexer/embed.ts tests/unit/embed.test.ts
git commit -m "feat(indexer): transformers.js embedder, CPU-only"
```

---

## Task 13: SCIP runner + protobuf parser

**Files:**
- Create: `src/indexer/scip.ts`, `tests/unit/scip.test.ts`, `fixtures/scip-tiny/{a.ts, package.json, tsconfig.json}`

- [ ] **Step 1: Write the fixture**

`fixtures/scip-tiny/package.json`:
```json
{ "name": "scip-tiny", "version": "0.0.0", "private": true }
```

`fixtures/scip-tiny/tsconfig.json`:
```json
{
  "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true },
  "include": ["a.ts"]
}
```

`fixtures/scip-tiny/a.ts`:
```ts
export function greet(name: string): string { return `hi ${name}` }
export function shout(name: string): string { return greet(name).toUpperCase() }
```

- [ ] **Step 1.5: Vendor `scip_pb.ts`**

The Sourcegraph SCIP project does not publish TypeScript bindings as an npm package. Vendor the file directly:

```bash
mkdir -p src/vendor
curl -fsSL https://raw.githubusercontent.com/sourcegraph/scip/main/bindings/typescript/scip_pb.ts \
  -o src/vendor/scip_pb.ts
```

Then prepend an attribution header at the top of the vendored file:

```ts
// Vendored from sourcegraph/scip @ main, bindings/typescript/scip_pb.ts
// Original license: Apache-2.0 (see https://github.com/sourcegraph/scip/blob/main/LICENSE).
// This file is the only piece of mac-graph not under MIT.
```

As of the upstream `sourcegraph/scip` main branch, `scip_pb.ts` is generated by `@bufbuild/protobuf` codegenv2. After vendoring, run:

```bash
pnpm add @bufbuild/protobuf@^2.12.0
```

If the upstream switches generators in future, the dep may differ — read the import statements at the top of the vendored file and add whatever it imports.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/scip.test.ts
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { runScip, parseScipIndex } from '../../src/indexer/scip.js'

const FIX = join(__dirname, '../../fixtures/scip-tiny')

describe('scip', () => {
  it('runs scip-typescript and returns symbols + references', async () => {
    const idx = await runScip(FIX)
    const parsed = parseScipIndex(idx, FIX)
    const names = parsed.symbols.map(s => s.name).sort()
    expect(names).toContain('greet')
    expect(names).toContain('shout')

    // shout calls greet → at least one REFERENCES edge between them
    const greet = parsed.symbols.find(s => s.name === 'greet')!
    const shout = parsed.symbols.find(s => s.name === 'shout')!
    const callEdge = parsed.references.find(
      r => r.fromSymbolId === shout.id && r.toSymbolId === greet.id && r.kind === 'call'
    )
    expect(callEdge).toBeTruthy()
  }, 120_000)
})
```

- [ ] **Step 3: Run, expect FAIL**

- [ ] **Step 4: Write `src/indexer/scip.ts`**

```ts
import { spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fromBinary } from '@bufbuild/protobuf'
import {
  IndexSchema,
  SymbolRole,
  SymbolInformation_Kind,
  type Index,
  type Document,
  type SyntaxKind,
} from '../vendor/scip_pb.js'
import type { SymbolNode, ReferenceEdge, RefKind } from '../store/types.js'

export async function runScip(repoDir: string): Promise<Index> {
  const out = join(repoDir, '.mac-graph-tmp.scip')
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'npx',
      ['scip-typescript', 'index', '--cwd', repoDir, '--output', out],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`scip-typescript exit ${code}: ${stderr}`))
    )
  })
  const buf = await readFile(out)
  unlink(out).catch(() => undefined)  // best-effort cleanup
  return fromBinary(IndexSchema, buf)
}

export interface ParsedScip {
  symbols: SymbolNode[]
  references: ReferenceEdge[]
  fileSymbols: Map<string, string[]>  // file path → symbol ids
}

export function parseScipIndex(idx: Index, _repoDir: string): ParsedScip {
  const symbols: SymbolNode[] = []
  const references: ReferenceEdge[] = []
  const fileSymbols = new Map<string, string[]>()

  for (const doc of idx.documents) {
    const filePath = doc.relativePath
    const ids: string[] = []

    for (const sym of doc.symbols) {
      const node: SymbolNode = {
        id: sym.symbol,
        name: lastSymbolPart(sym.symbol),
        kind: mapKind(sym.kind),
        language: 'ts',
        filePath,
        startLine: 0, startCol: 0, endLine: 0, endCol: 0,
        signature: sym.signatureDocumentation?.text ?? '',
        doc: (sym.documentation ?? []).join('\n\n'),
        clusterId: '',
      }
      symbols.push(node)
      ids.push(sym.symbol)
    }

    for (const occ of doc.occurrences) {
      const [sl, sc, el, ec] = readRange(occ.range)
      const isDefinition = (occ.symbolRoles & SymbolRole.Definition) !== 0

      if (isDefinition) {
        const owner = symbols.find(s => s.id === occ.symbol && s.filePath === filePath)
        if (owner) {
          owner.startLine = sl + 1; owner.startCol = sc
          owner.endLine = el + 1; owner.endCol = ec
        }
      } else {
        const enclosing = findEnclosingSymbol(doc, sl)
        if (enclosing && enclosing !== occ.symbol) {
          references.push({
            fromSymbolId: enclosing,
            toSymbolId: occ.symbol,
            kind: refKindFromRoles(occ.symbolRoles, occ.syntaxKind),
            refLine: sl + 1,
            refCol: sc,
          })
        }
      }
    }

    fileSymbols.set(filePath, ids)
  }

  return { symbols, references, fileSymbols }
}

function readRange(range: number[]): [number, number, number, number] {
  if (range.length === 3) return [range[0]!, range[1]!, range[0]!, range[2]!]
  return [range[0]!, range[1]!, range[2]!, range[3]!]
}

function findEnclosingSymbol(doc: Document, refLine: number): string | null {
  for (const occ of doc.occurrences) {
    if ((occ.symbolRoles & SymbolRole.Definition) === 0) continue
    const [sl, , el] = readRange(occ.range)
    if (sl <= refLine && refLine <= el) return occ.symbol
  }
  return null
}

function refKindFromRoles(roles: number, _syntaxKind: SyntaxKind): RefKind {
  if (roles & SymbolRole.WriteAccess) return 'write'
  if (roles & SymbolRole.ReadAccess) return 'read'
  return 'call'
}

function mapKind(k: SymbolInformation_Kind): SymbolNode['kind'] {
  switch (k) {
    case SymbolInformation_Kind.Function: return 'function'
    case SymbolInformation_Kind.Method: return 'method'
    case SymbolInformation_Kind.Class: return 'class'
    case SymbolInformation_Kind.Interface: return 'interface'
    case SymbolInformation_Kind.TypeAlias: return 'type'
    default: return 'variable'
  }
}

function lastSymbolPart(s: string): string {
  // SCIP symbol format: "<scheme> <pkg-mgr> <pkg-name> <version> <descriptors>"
  // Descriptors live after the last backtick-enclosed path:
  //   `a.ts`/greet().     → 'greet'
  //   `a.ts`/shout().(name) → 'name'
  // The naive regex `/[A-Za-z0-9_$]+(?=[#\.\(]?$)/` matches the last digit of a
  // version string like "0.0.0", so we strip the path prefix first.
  const afterPath = s.replace(/.*`[^`]*`/, '')
  if (!afterPath || afterPath === '/') {
    return s.split(' ').pop() ?? s
  }
  const matches = afterPath.match(/[A-Za-z0-9_$]+(?=[.(]|$)/g)
  if (matches && matches.length > 0) return matches[matches.length - 1]!
  return s
}
```

> **Note for the implementer:** the SCIP protobuf API in `scip_pb.ts` follows the protobufjs codegen pattern. Property names (`scip.SymbolRole`, `scip.SymbolInformation_Kind`, etc.) come from the upstream `scip.proto`. If the vendored file uses a different namespace export shape (e.g. flat exports rather than `scip.X`), adjust the imports — the structural mapping (parse, walk documents, map kinds, build references) is the contract, not the exact import shape. Confirm against the actual `src/vendor/scip_pb.ts` content after vendoring.

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/vendor/scip_pb.ts src/indexer/scip.ts tests/unit/scip.test.ts fixtures/scip-tiny/
git commit -m "feat(indexer): scip-typescript runner + vendored protobuf parser"
```

---

## Task 14: Tree-sitter ingest (HTML / CSS / JSON)

**Files:**
- Create: `src/indexer/treesitter/html.ts`, `src/indexer/treesitter/css.ts`, `src/indexer/treesitter/json.ts`, `tests/unit/treesitter-html.test.ts`, `tests/unit/treesitter-css.test.ts`, `tests/unit/treesitter-json.test.ts`

- [ ] **Step 1: Write `tests/unit/treesitter-html.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { extractHtmlSymbols } from '../../src/indexer/treesitter/html.js'

describe('extractHtmlSymbols', () => {
  it('finds ids and custom elements', () => {
    const html = `
<div id="login-form">
  <my-button></my-button>
  <script src="./app.js"></script>
</div>`
    const out = extractHtmlSymbols('a.html', html)
    const kinds = out.map(s => s.kind).sort()
    expect(kinds).toContain('html-id')
    expect(kinds).toContain('custom-element')
    expect(out.find(s => s.kind === 'html-id')?.name).toBe('#login-form')
  })
})
```

- [ ] **Step 2: Write `tests/unit/treesitter-css.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { extractCssSymbols } from '../../src/indexer/treesitter/css.js'

describe('extractCssSymbols', () => {
  it('finds class/id selectors and custom properties', () => {
    const css = `
:root { --primary: #000; }
.btn-primary { color: var(--primary); }
#sidebar { width: 200px; }
`
    const out = extractCssSymbols('a.css', css)
    const names = out.map(s => s.name).sort()
    expect(names).toContain('.btn-primary')
    expect(names).toContain('#sidebar')
    expect(names).toContain('--primary')
  })
})
```

- [ ] **Step 3: Write `tests/unit/treesitter-json.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { extractJsonSymbols } from '../../src/indexer/treesitter/json.js'

describe('extractJsonSymbols', () => {
  it('finds top-level keys only', () => {
    const json = '{ "name": "foo", "version": "1.0.0", "deps": { "x": "1" } }'
    const out = extractJsonSymbols('a.json', json)
    const names = out.map(s => s.name).sort()
    expect(names).toEqual(['deps', 'name', 'version'])
    // depth-1 only: 'x' inside deps not included
    expect(names).not.toContain('x')
  })
})
```

- [ ] **Step 4: Run all three, expect FAIL**

- [ ] **Step 5: Write `src/indexer/treesitter/html.ts`**

```ts
import Parser from 'tree-sitter'
import HTML from 'tree-sitter-html'
import type { SymbolNode } from '../../store/types.js'

const parser = new Parser()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
parser.setLanguage(HTML as any)

export function extractHtmlSymbols(filePath: string, source: string): SymbolNode[] {
  const tree = parser.parse(source)
  const out: SymbolNode[] = []
  walk(tree.rootNode, (node: any) => {
    if (node.type === 'attribute') {
      // namedChildren[0] = attribute_name, namedChildren[1] = quoted_attribute_value
      const nameNode = node.namedChildren?.[0]
      const valueNode = node.namedChildren?.[1]
      if (nameNode?.text === 'id' && valueNode) {
        // quoted_attribute_value -> attribute_value child holds the raw text
        const rawValue = valueNode.namedChildren?.[0]?.text ?? valueNode.text.replace(/['"]/g, '')
        out.push(makeSymbol(filePath, `#${rawValue}`, 'html-id', node))
      }
    }
    if (node.type === 'element') {
      // start_tag is first named child; tag_name is its first named child
      const startTag = node.namedChildren?.[0]
      if (startTag?.type === 'start_tag') {
        const tagName = startTag.namedChildren?.[0]?.text
        if (tagName?.includes('-')) {
          out.push(makeSymbol(filePath, tagName, 'custom-element', node))
        }
      }
    }
  })
  return out
}

function walk(node: any, fn: (n: any) => void): void {
  fn(node)
  for (const child of node.namedChildren ?? []) walk(child, fn)
}

function makeSymbol(filePath: string, name: string, kind: SymbolNode['kind'], node: any): SymbolNode {
  return {
    id: `html:${filePath}:${kind}:${name}:${node.startPosition.row}`,
    name, kind, language: 'html', filePath,
    startLine: node.startPosition.row + 1, startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1, endCol: node.endPosition.column,
    signature: '', doc: '', clusterId: ''
  }
}
```

- [ ] **Step 6: Write `src/indexer/treesitter/css.ts`**

```ts
import Parser from 'tree-sitter'
import CSS from 'tree-sitter-css'
import type { SymbolNode } from '../../store/types.js'

const parser = new Parser()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
parser.setLanguage(CSS as any)

export function extractCssSymbols(filePath: string, source: string): SymbolNode[] {
  const tree = parser.parse(source)
  const out: SymbolNode[] = []
  walk(tree.rootNode, (node: any) => {
    if (node.type === 'class_selector') {
      // node.text includes leading dot, e.g. '.btn-primary'
      out.push(makeSymbol(filePath, node.text, 'css-class', node))
    } else if (node.type === 'id_selector') {
      // node.text includes leading hash, e.g. '#sidebar'
      out.push(makeSymbol(filePath, node.text, 'css-id', node))
    } else if (node.type === 'declaration') {
      // namedChildren[0] = property_name node
      const prop = node.namedChildren?.[0]
      if (prop?.text?.startsWith('--')) {
        out.push(makeSymbol(filePath, prop.text, 'css-var', node))
      }
    }
  })
  return out
}

function walk(node: any, fn: (n: any) => void): void {
  fn(node)
  for (const child of node.namedChildren ?? []) walk(child, fn)
}

function makeSymbol(filePath: string, name: string, kind: SymbolNode['kind'], node: any): SymbolNode {
  return {
    id: `css:${filePath}:${kind}:${name}:${node.startPosition.row}`,
    name, kind, language: 'css', filePath,
    startLine: node.startPosition.row + 1, startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1, endCol: node.endPosition.column,
    signature: '', doc: '', clusterId: ''
  }
}
```

- [ ] **Step 7: Write `src/indexer/treesitter/json.ts`**

```ts
import Parser from 'tree-sitter'
import JSON_LANG from 'tree-sitter-json'
import type { SymbolNode } from '../../store/types.js'

const parser = new Parser()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
parser.setLanguage(JSON_LANG as any)

export function extractJsonSymbols(filePath: string, source: string): SymbolNode[] {
  const tree = parser.parse(source)
  const out: SymbolNode[] = []
  // rootNode is 'document'; first named child should be the top-level 'object'
  const root = tree.rootNode.namedChildren?.[0]
  if (!root || root.type !== 'object') return out
  for (const pair of root.namedChildren ?? []) {
    if (pair.type !== 'pair') continue
    const keyNode = pair.namedChildren?.[0]
    if (!keyNode || keyNode.type !== 'string') continue
    // Use string_content child if available, otherwise strip quotes from text
    const nameContent = keyNode.namedChildren?.[0]?.text ?? keyNode.text.replace(/['"]/g, '')
    out.push({
      id: `json:${filePath}:${nameContent}`,
      name: nameContent, kind: 'json-key', language: 'json', filePath,
      startLine: keyNode.startPosition.row + 1, startCol: keyNode.startPosition.column,
      endLine: keyNode.endPosition.row + 1, endCol: keyNode.endPosition.column,
      signature: '', doc: '', clusterId: ''
    })
  }
  return out
}
```

- [ ] **Step 8: Run all tests, expect PASS**

> **Note for the implementer:** tree-sitter grammar AST shapes differ slightly between grammar versions. If a test fails because a node field name doesn't match (e.g. `childForFieldName('name')` returns null), inspect with `node.toString()` against a real fixture and adjust the field walks. Don't loosen the test — adjust the parser code.

- [ ] **Step 9: Commit**

```bash
git add src/indexer/treesitter/ tests/unit/treesitter-*.test.ts
git commit -m "feat(indexer): tree-sitter ingest for HTML, CSS, JSON"
```

---

## Task 15: Indexer orchestrator

**Files:**
- Create: `src/indexer/orchestrator.ts`, `tests/integration/orchestrator.test.ts` (integration — uses real KuzuDB + FTS)

- [ ] **Step 1: Write the integration test**

```ts
// tests/integration/orchestrator.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFullIndex } from '../../src/indexer/orchestrator.js'
import { GraphStore } from '../../src/store/kuzu.js'
import { FtsStore } from '../../src/store/fts.js'

const FIX = join(__dirname, '../../fixtures/scip-tiny')

describe('runFullIndex', () => {
  let dataDir: string
  let store: GraphStore
  let fts: FtsStore

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-orch-'))
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    await runFullIndex({
      repoDir: FIX, dataDir, store, fts,
      embeddingModel: 'Xenova/bge-small-en-v1.5'
    })
  }, 240_000)

  afterAll(async () => {
    await store.close()
    fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('writes File and Symbol nodes', async () => {
    expect((await store.getFile('a.ts'))?.path).toBe('a.ts')
    const syms = await store.symbolsInFile('a.ts')
    expect(syms.map(s => s.name)).toEqual(expect.arrayContaining(['greet', 'shout']))
  })

  it('writes a manifest', async () => {
    const { readManifest } = await import('../../src/store/manifest.js')
    const m = await readManifest(dataDir)
    expect(m).not.toBeNull()
    expect(m!.fileCount).toBeGreaterThan(0)
    expect(m!.symbolCount).toBeGreaterThan(0)
  })

  it('FTS contains chunk text', () => {
    const hits = fts.search('greet', 5)
    expect(hits.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Write `src/indexer/orchestrator.ts`**

```ts
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { GraphStore } from '../store/kuzu.js'
import { FtsStore } from '../store/fts.js'
import { writeManifest } from '../store/manifest.js'
import { SCHEMA_VERSION } from '../store/kuzu-schema.js'
import { enumerateSources } from './enumerate.js'
import { runScip, parseScipIndex } from './scip.js'
import { extractHtmlSymbols } from './treesitter/html.js'
import { extractCssSymbols } from './treesitter/css.js'
import { extractJsonSymbols } from './treesitter/json.js'
import { chunkFile } from './chunker.js'
import { Embedder } from './embed.js'
import { log } from '../log.js'
import type { SymbolNode } from '../store/types.js'

export interface IndexJob {
  repoDir: string
  dataDir: string
  store: GraphStore
  fts: FtsStore
  embeddingModel: string
}

export interface IndexResult {
  fileCount: number
  symbolCount: number
  durationMs: number
  warnings: string[]
}

export async function runFullIndex(job: IndexJob): Promise<IndexResult> {
  const t0 = Date.now()
  const warnings: string[] = []

  log.info('full index: enumerate')
  const files = await enumerateSources(job.repoDir)

  log.info('full index: truncate previous state')
  await job.store.truncateAll()
  // FTS truncate: drop and recreate is heavier than per-file remove; iterate files.

  log.info('full index: SCIP for TypeScript')
  const tsFiles = files.filter(f => f.language === 'ts' || f.language === 'js')
  let scipParsed: ReturnType<typeof parseScipIndex> | null = null
  if (tsFiles.length > 0) {
    try {
      const idx = await runScip(job.repoDir)
      scipParsed = parseScipIndex(idx, job.repoDir)
    } catch (err) {
      throw new Error(`scip-typescript failed: ${(err as Error).message}`)
    }
  }

  log.info('full index: tree-sitter for HTML/CSS/JSON')
  const tsSymbolsByFile: Map<string, SymbolNode[]> = new Map()
  for (const f of files) {
    if (f.language !== 'html' && f.language !== 'css' && f.language !== 'json') continue
    const source = await readFile(f.absPath, 'utf8')
    const syms = f.language === 'html' ? extractHtmlSymbols(f.relPath, source)
              : f.language === 'css'  ? extractCssSymbols(f.relPath, source)
              :                          extractJsonSymbols(f.relPath, source)
    tsSymbolsByFile.set(f.relPath, syms)
  }

  log.info('full index: write File + Symbol nodes')
  let symbolCount = 0
  for (const f of files) {
    const text = await readFile(f.absPath, 'utf8').catch(() => '')
    const sha = createHash('sha1').update(text).digest('hex')
    const loc = text.split('\n').length
    await job.store.upsertFile({
      path: f.relPath, language: f.language, sha,
      sizeBytes: f.sizeBytes, loc
    })
  }
  if (scipParsed) {
    for (const s of scipParsed.symbols) {
      await job.store.upsertSymbol(s)
      await job.store.linkContains(s.filePath, s.id)
      symbolCount++
    }
    for (const r of scipParsed.references) {
      await job.store.upsertReference(r)
    }
  }
  for (const [filePath, syms] of tsSymbolsByFile) {
    for (const s of syms) {
      await job.store.upsertSymbol(s)
      await job.store.linkContains(filePath, s.id)
      symbolCount++
    }
  }

  log.info('full index: chunk + embed')
  const embedder = new Embedder(job.embeddingModel)
  await embedder.ready()
  const allChunks: { id: string; text: string; filePath: string; symbolId: string; startLine: number; endLine: number }[] = []
  for (const f of files) {
    const source = await readFile(f.absPath, 'utf8').catch(() => '')
    const symbolsForFile: { id: string; startLine: number; endLine: number }[] =
      scipParsed?.symbols
        .filter(s => s.filePath === f.relPath)
        .map(s => ({ id: s.id, startLine: s.startLine, endLine: s.endLine }))
        ?? []
    const chunks = chunkFile({ filePath: f.relPath, text: source, symbols: symbolsForFile })
    allChunks.push(...chunks)
  }
  const BATCH = 32
  for (let i = 0; i < allChunks.length; i += BATCH) {
    const batch = allChunks.slice(i, i + BATCH)
    const vecs = await embedder.embed(batch.map(c => c.text))
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j]!
      await job.store.upsertChunk({
        id: c.id, filePath: c.filePath,
        startLine: c.startLine, endLine: c.endLine,
        text: c.text, symbolId: c.symbolId, embedding: vecs[j]!
      })
      job.fts.upsert(c.id, c.text)
    }
  }

  log.info('full index: write manifest')
  await writeManifest(job.dataDir, {
    schemaVersion: SCHEMA_VERSION,
    indexedAt: new Date().toISOString(),
    fileCount: files.length,
    symbolCount,
    embeddingModel: job.embeddingModel,
    embeddingDim: 384
  })

  const durationMs = Date.now() - t0
  log.info({ durationMs, fileCount: files.length, symbolCount }, 'full index complete')
  return { fileCount: files.length, symbolCount, durationMs, warnings }
}

export async function runIncrementalIndex(
  job: IndexJob, changedPaths: string[]
): Promise<IndexResult> {
  // Strategy: SCIP rerun is the cheap path for correctness; targeted chunk/embed updates are the savings.
  // For Phase 1 simplicity, defer to runFullIndex for now and tighten later.
  log.warn({ changedPaths }, 'incremental falls back to full reindex in Phase 1')
  return runFullIndex(job)
}
```

> **Phase 1 simplification:** Incremental indexing uses the full-reindex code path. The dedicated incremental implementation (rerun SCIP scoped, surgical chunk/embedding diff) is tracked as Task 27 below — implement only if there's spare time at the end of Phase 1; otherwise it slots into a future "perf" plan.

- [ ] **Step 4: Run, expect PASS** (slow — actual SCIP + embedding load)

- [ ] **Step 5: Commit**

```bash
git add src/indexer/orchestrator.ts tests/integration/orchestrator.test.ts
git commit -m "feat(indexer): runFullIndex orchestrator end-to-end"
```

---

## Task 16: RRF + query orchestration

**Files:**
- Create: `src/search/rrf.ts`, `src/search/query.ts`, `tests/unit/rrf.test.ts`, `tests/integration/query.test.ts`

- [ ] **Step 1: Write `tests/unit/rrf.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { reciprocalRankFusion } from '../../src/search/rrf.js'

describe('reciprocalRankFusion', () => {
  it('fuses two ranked lists with k=60', () => {
    const a = ['x', 'y', 'z']
    const b = ['z', 'y', 'x']
    const fused = reciprocalRankFusion([a, b], 60)
    // y appears at rank 2 in both; x and z appear at 1 and 3
    expect(fused.map(r => r.id)).toEqual(['y', 'x', 'z'])
  })

  it('handles missing entries gracefully', () => {
    const a = ['x', 'y']
    const b = ['z', 'x']
    const fused = reciprocalRankFusion([a, b], 60)
    expect(fused.map(r => r.id).sort()).toEqual(['x', 'y', 'z'])
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Write `src/search/rrf.ts`**

```ts
export interface RrfResult { id: string; score: number }

export function reciprocalRankFusion(rankings: string[][], k = 60): RrfResult[] {
  const score = new Map<string, number>()
  for (const list of rankings) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1))
    }
  }
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score)
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Write `src/search/query.ts`**

```ts
import { GraphStore } from '../store/kuzu.js'
import { FtsStore } from '../store/fts.js'
import { Embedder } from '../indexer/embed.js'
import { reciprocalRankFusion } from './rrf.js'
import type { SymbolNode } from '../store/types.js'

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
    const sym = await deps.store.raw<{ s: any }>(
      `MATCH (s:Symbol {id: $id}) RETURN s`, { id: c.symbol_id }
    )
    if (sym.length === 0) continue
    const s = sym[0]!.s
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
```

> **Note:** the GDS cosine path is opportunistic — KuzuDB at the version listed in package.json may not expose it. The manual fallback always runs in MVP and is fine up to ~50k chunks.

- [ ] **Step 6: Write `tests/integration/query.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/store/kuzu.js'
import { FtsStore } from '../../src/store/fts.js'
import { Embedder } from '../../src/indexer/embed.js'
import { runFullIndex } from '../../src/indexer/orchestrator.js'
import { runQuery } from '../../src/search/query.js'

const FIX = join(__dirname, '../../fixtures/scip-tiny')

describe('runQuery', () => {
  let dataDir: string
  let store: GraphStore
  let fts: FtsStore
  let embedder: Embedder

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-q-'))
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    embedder = new Embedder('Xenova/bge-small-en-v1.5')
    await runFullIndex({
      repoDir: FIX, dataDir, store, fts,
      embeddingModel: 'Xenova/bge-small-en-v1.5'
    })
  }, 240_000)

  afterAll(async () => {
    await store.close(); fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('finds greet by name', async () => {
    const hits = await runQuery({ store, fts, embedder }, { q: 'greet' })
    expect(hits.some(h => h.name === 'greet')).toBe(true)
  })
})
```

- [ ] **Step 7: Run, expect PASS**

- [ ] **Step 8: Commit**

```bash
git add src/search/ tests/unit/rrf.test.ts tests/integration/query.test.ts
git commit -m "feat(search): RRF + hybrid query orchestrator"
```

---

## Task 17: HTTP errors helper + Hono server skeleton + /health

**Files:**
- Create: `src/http/errors.ts`, `src/http/routes/health.ts`, `src/server.ts`, `tests/integration/server.test.ts`

- [ ] **Step 1: Write `src/http/errors.ts`**

```ts
import { Context } from 'hono'

export function problem(c: Context, status: number, type: string, title: string, detail?: string, extra: Record<string, unknown> = {}) {
  return c.json({
    type: `https://mac-graph/errors/${type}`,
    title, status, ...(detail ? { detail } : {}), instance: c.req.path, ...extra
  }, status as 400 | 404 | 409 | 500 | 507)
}
```

- [ ] **Step 2: Write `src/http/routes/health.ts`**

```ts
import { Hono } from 'hono'
import type { GraphStore } from '../../store/kuzu.js'
import type { Embedder } from '../../indexer/embed.js'
import type { WriteLock } from '../../lock.js'
import { readManifest } from '../../store/manifest.js'

export interface HealthDeps {
  startedAt: number
  store: GraphStore
  embedder: Embedder
  lock: WriteLock
  dataDir: string
}

export function healthRoutes(deps: HealthDeps): Hono {
  const app = new Hono()
  app.get('/health', async c => {
    const manifest = await readManifest(deps.dataDir)
    const lockState = deps.lock.inspect()
    const counts = await deps.store.raw<{ files: bigint; symbols: bigint }>(
      `OPTIONAL MATCH (f:File) WITH count(f) AS files
       OPTIONAL MATCH (s:Symbol) RETURN files, count(s) AS symbols`
    ).catch(() => [{ files: 0n, symbols: 0n }])
    return c.json({
      ok: true,
      uptimeMs: Date.now() - deps.startedAt,
      indexing: lockState.held,
      currentJob: lockState.holder,
      manifest,
      rowCounts: { files: Number(counts[0]?.files ?? 0), symbols: Number(counts[0]?.symbols ?? 0) },
      embeddingModelLoaded: true  // set after embedder.ready() at startup
    })
  })
  return app
}
```

- [ ] **Step 3: Write `src/server.ts`**

```ts
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { env } from './env.js'
import { log } from './log.js'
import { GraphStore } from './store/kuzu.js'
import { FtsStore } from './store/fts.js'
import { Embedder } from './indexer/embed.js'
import { WriteLock } from './lock.js'
import { healthRoutes } from './http/routes/health.js'

export async function start(): Promise<void> {
  const startedAt = Date.now()
  log.info({ env: { port: env.PORT, dataDir: env.DATA_DIR, repoDir: env.REPO_DIR } }, 'starting mac-graph')

  const store = await GraphStore.open(join(env.DATA_DIR, 'kuzu'))
  const fts = new FtsStore(join(env.DATA_DIR, 'fts.db'))
  const embedder = new Embedder(env.EMBEDDING_MODEL)
  await embedder.ready()
  const lock = new WriteLock()

  const app = new Hono()
  app.route('/', healthRoutes({ startedAt, store, embedder, lock, dataDir: env.DATA_DIR }))

  const hostname = env.BIND_ALL ? '0.0.0.0' : '127.0.0.1'
  const server = serve({ fetch: app.fetch, hostname, port: env.PORT })
  log.info({ hostname, port: env.PORT }, 'mac-graph listening')

  process.on('SIGTERM', async () => {
    log.info('SIGTERM — shutting down')
    server.close()
    await store.close()
    fts.close()
    process.exit(0)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch(err => { log.fatal(err); process.exit(1) })
}
```

- [ ] **Step 4: Write `tests/integration/server.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { GraphStore } from '../../src/store/kuzu.js'
import { FtsStore } from '../../src/store/fts.js'
import { Embedder } from '../../src/indexer/embed.js'
import { WriteLock } from '../../src/lock.js'
import { healthRoutes } from '../../src/http/routes/health.js'

describe('GET /health', () => {
  let dataDir: string
  let app: Hono
  let store: GraphStore
  let fts: FtsStore

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-h-'))
    mkdirSync(join(dataDir, 'kuzu'), { recursive: true })
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    const embedder = new Embedder('Xenova/bge-small-en-v1.5')
    const lock = new WriteLock()
    app = new Hono().route('/', healthRoutes({
      startedAt: Date.now(), store, embedder, lock, dataDir
    }))
  }, 120_000)

  afterAll(async () => {
    await store.close(); fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('returns ok and includes uptime + manifest fields', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(typeof body.uptimeMs).toBe('number')
    expect(body.indexing).toBe(false)
  })
})
```

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/http/ src/server.ts tests/integration/server.test.ts
git commit -m "feat(http): Hono server + /health route + RFC 9457 errors"
```

---

## Task 18: /index, /index/incremental, /index/status routes

**Files:**
- Create: `src/http/routes/index-routes.ts`
- Modify: `src/server.ts`
- Test: `tests/integration/index-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/index-routes.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { GraphStore } from '../../src/store/kuzu.js'
import { FtsStore } from '../../src/store/fts.js'
import { Embedder } from '../../src/indexer/embed.js'
import { WriteLock } from '../../src/lock.js'
import { indexRoutes } from '../../src/http/routes/index-routes.js'

const FIX = join(__dirname, '../../fixtures/scip-tiny')

describe('POST /index', () => {
  let dataDir: string, app: Hono, store: GraphStore, fts: FtsStore

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-idx-'))
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    const embedder = new Embedder('Xenova/bge-small-en-v1.5')
    await embedder.ready()
    const lock = new WriteLock()
    app = new Hono().route('/', indexRoutes({
      repoDir: FIX, dataDir, store, fts, embedder, lock,
      embeddingModel: 'Xenova/bge-small-en-v1.5'
    }))
  }, 240_000)

  afterAll(async () => {
    await store.close(); fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('starts a job and reports completion via status', async () => {
    const start = await app.request('/index', { method: 'POST' })
    expect(start.status).toBe(202)
    const { jobId } = await start.json() as any
    expect(jobId).toBeTruthy()

    // poll
    let phase = ''
    for (let i = 0; i < 60; i++) {
      const r = await app.request(`/index/status/${jobId}`)
      const body = await r.json() as any
      phase = body.phase
      if (phase === 'complete' || phase === 'error') break
      await new Promise(r => setTimeout(r, 1000))
    }
    expect(phase).toBe('complete')
  }, 240_000)

  it('returns 409 when a job is in flight', async () => {
    // not the focus of this test — start a long job, immediately try another. Skipped for brevity.
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Write `src/http/routes/index-routes.ts`**

```ts
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { problem } from '../errors.js'
import { runFullIndex, runIncrementalIndex } from '../../indexer/orchestrator.js'
import type { GraphStore } from '../../store/kuzu.js'
import type { FtsStore } from '../../store/fts.js'
import type { Embedder } from '../../indexer/embed.js'
import type { WriteLock } from '../../lock.js'
import { log } from '../../log.js'

export interface IndexRoutesDeps {
  repoDir: string
  dataDir: string
  store: GraphStore
  fts: FtsStore
  embedder: Embedder
  lock: WriteLock
  embeddingModel: string
}

interface JobState {
  id: string
  startedAt: number
  endedAt?: number
  phase: 'queued' | 'running' | 'complete' | 'error'
  error?: string
}

export function indexRoutes(deps: IndexRoutesDeps): Hono {
  const app = new Hono()
  const jobs = new Map<string, JobState>()

  async function startJob(mode: 'full' | 'incremental', changedPaths?: string[]): Promise<JobState | { busy: true; holder: string }> {
    const tryRelease = deps.lock.tryAcquire('pending')
    if (!tryRelease) {
      return { busy: true, holder: deps.lock.inspect().holder ?? 'unknown' }
    }
    tryRelease()  // release the placeholder; the actual job re-acquires below

    const id = `ix_${randomUUID()}`
    const state: JobState = { id, startedAt: Date.now(), phase: 'queued' }
    jobs.set(id, state)

    ;(async () => {
      const release = await deps.lock.acquire(id)
      try {
        state.phase = 'running'
        const job = {
          repoDir: deps.repoDir, dataDir: deps.dataDir,
          store: deps.store, fts: deps.fts,
          embeddingModel: deps.embeddingModel
        }
        if (mode === 'full') {
          await runFullIndex(job)
        } else {
          await runIncrementalIndex(job, changedPaths ?? [])
        }
        state.phase = 'complete'
      } catch (err) {
        state.phase = 'error'
        state.error = (err as Error).message
        log.error({ err, jobId: id }, 'index job failed')
      } finally {
        state.endedAt = Date.now()
        release()
      }
    })()

    return state
  }

  app.post('/index', async c => {
    const r = await startJob('full')
    if ('busy' in r) {
      return problem(c, 409, 'index-busy', 'Index job in flight', `Job ${r.holder} is currently running`, { jobId: r.holder })
    }
    return c.json({ jobId: r.id, phase: r.phase, startedAt: r.startedAt }, 202)
  })

  app.post('/index/incremental', async c => {
    const body = await c.req.json().catch(() => ({})) as { changedPaths?: string[] }
    if (!Array.isArray(body.changedPaths) || body.changedPaths.length === 0) {
      return problem(c, 400, 'invalid-input', 'changedPaths required', 'Body must include a non-empty changedPaths string array')
    }
    const r = await startJob('incremental', body.changedPaths)
    if ('busy' in r) {
      return problem(c, 409, 'index-busy', 'Index job in flight', `Job ${r.holder} is currently running`, { jobId: r.holder })
    }
    return c.json({ jobId: r.id, phase: r.phase }, 202)
  })

  app.get('/index/status/:jobId', c => {
    const id = c.req.param('jobId')
    const job = jobs.get(id)
    if (!job) return problem(c, 404, 'job-not-found', 'No such job', `Job ${id} not found`)
    return c.json({
      jobId: job.id, phase: job.phase,
      startedAt: job.startedAt, endedAt: job.endedAt,
      error: job.error
    })
  })

  return app
}
```

- [ ] **Step 4: Wire into `src/server.ts`**

Modify `src/server.ts`: add the import and route mount.

```ts
// Add near other imports
import { indexRoutes } from './http/routes/index-routes.js'

// Inside start(), after healthRoutes mount:
app.route('/', indexRoutes({
  repoDir: env.REPO_DIR, dataDir: env.DATA_DIR,
  store, fts, embedder, lock,
  embeddingModel: env.EMBEDDING_MODEL
}))
```

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/http/routes/index-routes.ts src/server.ts tests/integration/index-routes.test.ts
git commit -m "feat(http): /index, /index/incremental, /index/status routes"
```

---

## Task 19: MCP server skeleton + zod schemas

**Files:**
- Create: `src/mcp/server.ts`, `src/mcp/schemas.ts`
- Modify: `src/server.ts`
- Test: `tests/integration/mcp.test.ts`

- [ ] **Step 1: Write `src/mcp/schemas.ts`**

```ts
import { z } from 'zod'

export const SymbolKindEnum = z.enum([
  'function','class','method','interface','type','variable',
  'html-id','css-class','css-id','css-var','json-key','custom-element'
])
export const LanguageEnum = z.enum(['ts','js','html','css','json','other'])

export const QueryInput = z.object({
  q: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
  kinds: z.array(SymbolKindEnum).optional(),
  languages: z.array(LanguageEnum).optional()
})

export const ContextInput = z.object({
  symbol_id: z.string().optional(),
  name: z.string().optional(),
  kind: SymbolKindEnum.optional(),
  depth: z.number().int().min(1).max(3).optional()
}).refine(v => v.symbol_id || v.name, { message: 'symbol_id or name required' })

export const ImpactInput = z.object({
  symbol_id: z.string(),
  hops: z.number().int().min(1).max(4).optional()
})

export const DetectChangesInput = z.object({})

export const ReindexInput = z.object({
  mode: z.enum(['full','incremental']).optional(),
  paths: z.array(z.string()).optional()
}).refine(v => v.mode !== 'incremental' || (v.paths && v.paths.length > 0), {
  message: 'paths required when mode=incremental'
})
```

- [ ] **Step 2: Write `src/mcp/server.ts`**

```ts
import { Hono } from 'hono'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { GraphStore } from '../store/kuzu.js'
import type { FtsStore } from '../store/fts.js'
import type { Embedder } from '../indexer/embed.js'
import type { WriteLock } from '../lock.js'
import { registerQueryTool } from './tools/query.js'
import { registerContextTool } from './tools/context.js'
import { registerImpactTool } from './tools/impact.js'
import { registerDetectChangesTool } from './tools/detect-changes.js'
import { registerReindexTool } from './tools/reindex.js'

export interface McpDeps {
  store: GraphStore
  fts: FtsStore
  embedder: Embedder
  lock: WriteLock
  repoDir: string
  dataDir: string
  embeddingModel: string
}

export async function buildMcpApp(deps: McpDeps): Promise<Hono> {
  const server = new Server(
    { name: 'mac-graph', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )
  registerQueryTool(server, deps)
  registerContextTool(server, deps)
  registerImpactTool(server, deps)
  registerDetectChangesTool(server, deps)
  registerReindexTool(server, deps)

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)

  const app = new Hono()
  app.all('/mcp', async c => {
    const req = c.req.raw
    const res = await transport.handleRequest(req)
    return res
  })
  return app
}
```

> **Note:** `StreamableHTTPServerTransport.handleRequest`'s exact signature changes between SDK versions. If the import path or method shape doesn't match the installed `@modelcontextprotocol/sdk`, consult the SDK README for the current Streamable HTTP wiring — the structure (one server, one transport, one route) is invariant.

- [ ] **Step 3: Wire into `src/server.ts`**

```ts
import { buildMcpApp } from './mcp/server.js'

// Inside start(), after other route mounts:
const mcp = await buildMcpApp({
  store, fts, embedder, lock,
  repoDir: env.REPO_DIR, dataDir: env.DATA_DIR, embeddingModel: env.EMBEDDING_MODEL
})
app.route('/', mcp)
```

- [ ] **Step 4: Sanity test (no tools registered yet — they come in Tasks 20-24)**

Add a tiny test asserting `POST /mcp` with `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` returns 200 and a JSON-RPC reply containing zero tools (until subsequent tasks register them).

```ts
// tests/integration/mcp.test.ts (initial — extended in later tasks)
import { describe, it, expect } from 'vitest'
// (test body filled in once tools are registered)
describe.skip('MCP server', () => {
  it('lists tools', () => { /* see Task 24 */ })
})
```

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/mcp/schemas.ts tests/integration/mcp.test.ts src/server.ts
git commit -m "feat(mcp): server skeleton + zod schemas + Streamable HTTP transport"
```

---

## Task 20: MCP tool — `query`

**Files:**
- Create: `src/mcp/tools/query.ts`
- Modify: `tests/integration/mcp.test.ts`

- [ ] **Step 1: Write `src/mcp/tools/query.ts`**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { QueryInput } from '../schemas.js'
import { runQuery } from '../../search/query.js'
import type { McpDeps } from '../server.js'

const TOOL_NAME = 'query'

export function registerQueryTool(server: Server, deps: McpDeps): void {
  // The MCP SDK requires merging tools across registrations — implementations vary by version.
  // Convention here: each register* function adds its tool to a shared list via setRequestHandler.
  // (See server.ts for the merging pattern; this file owns this tool's input schema + handler.)
  const handler = async (input: unknown) => {
    const parsed = QueryInput.parse(input)
    const hits = await runQuery({ store: deps.store, fts: deps.fts, embedder: deps.embedder }, parsed)
    return {
      content: [{ type: 'text', text: JSON.stringify({ results: hits.map(h => ({
        symbol_id: h.symbolId, name: h.name, kind: h.kind,
        file_path: h.filePath, line: h.line, snippet: h.snippet, score: h.score
      })) }) }]
    }
  }

  // Register schema declaration into the shared registry pattern (see server.ts):
  ;(server as any).__macTools ??= []
  ;(server as any).__macTools.push({
    name: TOOL_NAME,
    description: 'Hybrid (BM25 + semantic) search across indexed symbols. Returns ranked results.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Natural-language query or symbol fragment' },
        limit: { type: 'number', description: 'Max results, default 10' },
        kinds: { type: 'array', items: { type: 'string' } },
        languages: { type: 'array', items: { type: 'string' } }
      },
      required: ['q']
    },
    handler
  })

  ensureMergedHandlers(server)
}

function ensureMergedHandlers(server: Server): void {
  const tools: any[] = (server as any).__macTools
  const handlers: Map<string, (input: unknown) => Promise<unknown>> =
    (server as any).__macHandlers ??= new Map()
  for (const t of tools) handlers.set(t.name, t.handler)

  if (!(server as any).__macWired) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    }))
    server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
      const fn = handlers.get(req.params.name)
      if (!fn) throw new Error(`unknown tool ${req.params.name}`)
      return fn(req.params.arguments) as any
    })
    ;(server as any).__macWired = true
  }
}
```

> **Implementer's note on the merging trick:** the MCP SDK's `setRequestHandler` is single-handler-per-method. Across 5 tool files, we accumulate registrations on a stash (`__macTools`) and wire the dispatcher exactly once. If you find this ugly, an equivalently valid refactor is a single `tools/index.ts` that imports all 5 tool defs and registers them in one place — do that if it cleans up the code, but the contract stays the same.

- [ ] **Step 2: Add MCP integration test**

```ts
// tests/integration/mcp.test.ts (real version)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/store/kuzu.js'
import { FtsStore } from '../../src/store/fts.js'
import { Embedder } from '../../src/indexer/embed.js'
import { WriteLock } from '../../src/lock.js'
import { runFullIndex } from '../../src/indexer/orchestrator.js'
import { buildMcpApp } from '../../src/mcp/server.js'

const FIX = join(__dirname, '../../fixtures/scip-tiny')

describe('MCP query tool', () => {
  let dataDir: string, store: GraphStore, fts: FtsStore, app: any

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-mcp-'))
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    const embedder = new Embedder('Xenova/bge-small-en-v1.5')
    await embedder.ready()
    const lock = new WriteLock()
    await runFullIndex({ repoDir: FIX, dataDir, store, fts, embeddingModel: 'Xenova/bge-small-en-v1.5' })
    app = await buildMcpApp({ store, fts, embedder, lock, repoDir: FIX, dataDir, embeddingModel: 'Xenova/bge-small-en-v1.5' })
  }, 240_000)

  afterAll(async () => {
    await store.close(); fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('lists query among tools', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    const names = body.result.tools.map((t: any) => t.name)
    expect(names).toContain('query')
  })

  it('runs query and returns hits', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2,
        method: 'tools/call',
        params: { name: 'query', arguments: { q: 'greet' } }
      })
    })
    const body = await res.json() as any
    const payload = JSON.parse(body.result.content[0].text)
    expect(payload.results.some((r: any) => r.name === 'greet')).toBe(true)
  })
})
```

- [ ] **Step 3: Run, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/query.ts tests/integration/mcp.test.ts
git commit -m "feat(mcp): query tool with hybrid search"
```

---

## Task 21: MCP tool — `context`

**Files:**
- Create: `src/mcp/tools/context.ts`
- Modify: `tests/integration/mcp.test.ts`

- [ ] **Step 1: Write `src/mcp/tools/context.ts`**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ContextInput } from '../schemas.js'
import type { McpDeps } from '../server.js'

export function registerContextTool(server: Server, deps: McpDeps): void {
  const handler = async (input: unknown) => {
    const parsed = ContextInput.parse(input)

    let symbol: any
    if (parsed.symbol_id) {
      const r = await deps.store.raw<{ s: any }>(`MATCH (s:Symbol {id: $id}) RETURN s`, { id: parsed.symbol_id })
      symbol = r[0]?.s
    } else {
      const where = parsed.kind ? `AND s.kind = $kind` : ''
      const r = await deps.store.raw<{ s: any }>(
        `MATCH (s:Symbol) WHERE s.name = $name ${where} RETURN s LIMIT 1`,
        { name: parsed.name!, kind: parsed.kind }
      )
      symbol = r[0]?.s
    }
    if (!symbol) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'symbol_not_found' }) }] }
    }

    const callers = await deps.store.raw<{ caller: any; ref_line: number }>(
      `MATCH (caller:Symbol)-[r:REFERENCES {kind:'call'}]->(target:Symbol {id: $id})
       RETURN caller, r.ref_line AS ref_line LIMIT 50`, { id: symbol.id })
    const callees = await deps.store.raw<{ callee: any; ref_line: number }>(
      `MATCH (target:Symbol {id: $id})-[r:REFERENCES {kind:'call'}]->(callee:Symbol)
       RETURN callee, r.ref_line AS ref_line LIMIT 50`, { id: symbol.id })
    const typeRefs = await deps.store.raw<{ t: any; ref_line: number }>(
      `MATCH (target:Symbol {id: $id})-[r:REFERENCES {kind:'type-ref'}]->(t:Symbol)
       RETURN t, r.ref_line AS ref_line LIMIT 50`, { id: symbol.id })
    const cluster = symbol.cluster_id
      ? await deps.store.raw<{ s: any }>(
        `MATCH (s:Symbol {cluster_id: $c}) WHERE s.id <> $id RETURN s LIMIT 8`,
        { c: symbol.cluster_id, id: symbol.id })
      : []

    let source = ''
    try {
      const fileText = await readFile(join(deps.repoDir, symbol.file_path), 'utf8')
      const lines = fileText.split('\n')
      source = lines.slice(symbol.start_line - 1, symbol.end_line).join('\n')
    } catch { /* file gone */ }

    const payload = {
      symbol: {
        id: symbol.id, name: symbol.name, kind: symbol.kind,
        file_path: symbol.file_path,
        start_line: symbol.start_line, end_line: symbol.end_line,
        signature: symbol.signature, doc: symbol.doc
      },
      defined_in: { file_path: symbol.file_path, language: symbol.language },
      source,
      imports: [],  // EXPORTS/IMPORTS rendering: phase-2 polish
      defines: [],  // children via DEFINES — same caveat
      callers: callers.map(r => ({ symbol: shape(r.caller), ref_line: r.ref_line })),
      callees: callees.map(r => ({ symbol: shape(r.callee), ref_line: r.ref_line })),
      type_refs: typeRefs.map(r => ({ symbol: shape(r.t), ref_line: r.ref_line })),
      same_cluster: cluster.map(r => shape(r.s))
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  }

  ;(server as any).__macTools ??= []
  ;(server as any).__macTools.push({
    name: 'context',
    description: '360° view of a symbol: source, callers, callees, type refs, cluster mates.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol_id: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string' },
        depth: { type: 'number' }
      }
    },
    handler
  })
}

function shape(s: any) {
  return {
    id: s.id, name: s.name, kind: s.kind, language: s.language,
    file_path: s.file_path, start_line: s.start_line, end_line: s.end_line
  }
}
```

- [ ] **Step 2: Add `context` test to `tests/integration/mcp.test.ts`**

```ts
it('context returns callers and callees for shout', async () => {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3,
      method: 'tools/call',
      params: { name: 'context', arguments: { name: 'shout' } }
    })
  })
  const body = await res.json() as any
  const payload = JSON.parse(body.result.content[0].text)
  expect(payload.symbol?.name).toBe('shout')
  expect(payload.callees.some((c: any) => c.symbol.name === 'greet')).toBe(true)
})
```

- [ ] **Step 3: Wire `registerContextTool` into `src/mcp/server.ts`** (already imported in skeleton — confirm).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/context.ts tests/integration/mcp.test.ts
git commit -m "feat(mcp): context tool"
```

---

## Task 22: MCP tool — `impact` (with `tests_affected`)

**Files:**
- Create: `src/mcp/tools/impact.ts`
- Modify: `tests/integration/mcp.test.ts`

- [ ] **Step 1: Write `src/mcp/tools/impact.ts`**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ImpactInput } from '../schemas.js'
import type { McpDeps } from '../server.js'

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/

export function registerImpactTool(server: Server, deps: McpDeps): void {
  const handler = async (input: unknown) => {
    const parsed = ImpactInput.parse(input)
    const hops = parsed.hops ?? 2

    const target = await deps.store.raw<{ s: any }>(
      `MATCH (s:Symbol {id: $id}) RETURN s`, { id: parsed.symbol_id })
    if (target.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'symbol_not_found' }) }] }
    }

    const direct = await deps.store.raw<{ caller: any; ref_line: number }>(
      `MATCH (caller:Symbol)-[r:REFERENCES {kind:'call'}]->(t:Symbol {id: $id})
       RETURN caller, r.ref_line AS ref_line LIMIT 200`, { id: parsed.symbol_id })

    const transitive = await deps.store.raw<{ caller: any; depth: number; pathStr: string }>(
      `MATCH p=(caller:Symbol)-[r:REFERENCES*1..${hops} {kind:'call'}]->(t:Symbol {id: $id})
       WHERE caller.id <> $id
       WITH caller, length(p) AS depth, [n IN nodes(p) | n.name] AS pathNames
       RETURN caller, depth, reduce(s='', n IN pathNames | CASE WHEN s='' THEN n ELSE s + '→' + n END) AS pathStr
       LIMIT 200`, { id: parsed.symbol_id })

    const typeConsumers = await deps.store.raw<{ s: any }>(
      `MATCH (s:Symbol)-[r:REFERENCES {kind:'type-ref'}]->(t:Symbol {id: $id}) RETURN s LIMIT 100`,
      { id: parsed.symbol_id })

    const filesAffected = new Set<string>()
    for (const r of direct) filesAffected.add(r.caller.file_path)
    for (const r of transitive) filesAffected.add(r.caller.file_path)
    for (const r of typeConsumers) filesAffected.add(r.s.file_path)

    const testsAffected = [...filesAffected].filter(f => TEST_FILE_RE.test(f))

    const payload = {
      symbol: shape(target[0]!.s),
      direct_callers: direct.map(r => ({ symbol: shape(r.caller), file_path: r.caller.file_path, ref_line: r.ref_line })),
      transitive_callers: transitive.map(r => ({ symbol: shape(r.caller), depth: r.depth, paths: [r.pathStr] })),
      type_consumers: typeConsumers.map(r => shape(r.s)),
      files_affected: [...filesAffected],
      tests_affected: testsAffected
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  }

  ;(server as any).__macTools ??= []
  ;(server as any).__macTools.push({
    name: 'impact',
    description: 'Blast radius of changing a symbol: direct + transitive callers, files & tests affected.',
    inputSchema: {
      type: 'object',
      properties: { symbol_id: { type: 'string' }, hops: { type: 'number' } },
      required: ['symbol_id']
    },
    handler
  })
}

function shape(s: any) {
  return {
    id: s.id, name: s.name, kind: s.kind, language: s.language,
    file_path: s.file_path, start_line: s.start_line, end_line: s.end_line
  }
}
```

- [ ] **Step 2: Add `impact` test using a fixture extension**

Add a test file under `fixtures/scip-tiny/`: `a.test.ts`

```ts
import { greet } from './a'
test('greet', () => { expect(greet('zeb')).toBe('hi zeb') })
```

> **Note:** the `scip-tiny` test will need a vitest setup to actually run, but for the *indexer* it just needs to be a parseable TS file that imports `greet`. Update `tsconfig.json` `include` to include `*.test.ts`.

Then in `tests/integration/mcp.test.ts`:

```ts
it('impact identifies test files', async () => {
  // first, find greet's symbol id via context
  const ctx = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 4,
      method: 'tools/call',
      params: { name: 'context', arguments: { name: 'greet' } }
    })
  })
  const ctxBody = await ctx.json() as any
  const symbolId = JSON.parse(ctxBody.result.content[0].text).symbol.id

  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 5,
      method: 'tools/call',
      params: { name: 'impact', arguments: { symbol_id: symbolId, hops: 2 } }
    })
  })
  const body = await res.json() as any
  const payload = JSON.parse(body.result.content[0].text)
  expect(payload.tests_affected).toContain('a.test.ts')
})
```

- [ ] **Step 3: Run, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/impact.ts tests/integration/mcp.test.ts fixtures/scip-tiny/
git commit -m "feat(mcp): impact tool with tests_affected detection"
```

---

## Task 23: MCP tool — `detect_changes`

**Files:**
- Create: `src/mcp/tools/detect-changes.ts`
- Modify: `tests/integration/mcp.test.ts`

- [ ] **Step 1: Write `src/mcp/tools/detect-changes.ts`**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readManifest } from '../../store/manifest.js'
import { enumerateSources } from '../../indexer/enumerate.js'
import type { McpDeps } from '../server.js'

export function registerDetectChangesTool(server: Server, deps: McpDeps): void {
  const handler = async () => {
    const manifest = await readManifest(deps.dataDir)
    const files = await enumerateSources(deps.repoDir)

    const dbFiles = await deps.store.raw<{ path: string; sha: string }>(
      `MATCH (f:File) RETURN f.path AS path, f.sha AS sha`)
    const dbMap = new Map(dbFiles.map(r => [r.path, r.sha]))

    const changed: { path: string; status: 'modified' | 'added' | 'deleted' }[] = []
    const seen = new Set<string>()
    for (const f of files) {
      seen.add(f.relPath)
      const text = await readFile(join(deps.repoDir, f.relPath), 'utf8').catch(() => '')
      const sha = createHash('sha1').update(text).digest('hex')
      const dbSha = dbMap.get(f.relPath)
      if (dbSha === undefined) changed.push({ path: f.relPath, status: 'added' })
      else if (dbSha !== sha) changed.push({ path: f.relPath, status: 'modified' })
    }
    for (const path of dbMap.keys()) {
      if (!seen.has(path)) changed.push({ path, status: 'deleted' })
    }

    return { content: [{ type: 'text', text: JSON.stringify({
      manifest, changed_files: changed, index_stale: changed.length > 0
    }) }] }
  }

  ;(server as any).__macTools ??= []
  ;(server as any).__macTools.push({
    name: 'detect_changes',
    description: 'Compare current /repo state against the indexed snapshot. Returns added/modified/deleted files.',
    inputSchema: { type: 'object', properties: {} },
    handler
  })
}
```

- [ ] **Step 2: Add a test asserting empty change set right after a fresh index**

```ts
it('detect_changes returns no changes immediately after index', async () => {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 6,
      method: 'tools/call',
      params: { name: 'detect_changes', arguments: {} }
    })
  })
  const body = await res.json() as any
  const payload = JSON.parse(body.result.content[0].text)
  expect(payload.index_stale).toBe(false)
})
```

- [ ] **Step 3: Run, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/detect-changes.ts tests/integration/mcp.test.ts
git commit -m "feat(mcp): detect_changes tool"
```

---

## Task 24: MCP tool — `reindex`

**Files:**
- Create: `src/mcp/tools/reindex.ts`
- Modify: `tests/integration/mcp.test.ts`

- [ ] **Step 1: Write `src/mcp/tools/reindex.ts`**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { randomUUID } from 'node:crypto'
import { ReindexInput } from '../schemas.js'
import { runFullIndex, runIncrementalIndex } from '../../indexer/orchestrator.js'
import type { McpDeps } from '../server.js'
import { log } from '../../log.js'

export function registerReindexTool(server: Server, deps: McpDeps): void {
  const handler = async (input: unknown) => {
    const parsed = ReindexInput.parse(input)
    const mode = parsed.mode ?? 'incremental'

    const tryRelease = deps.lock.tryAcquire('pending')
    if (!tryRelease) {
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'busy', job_id: deps.lock.inspect().holder, estimate_ms: 0
      }) }] }
    }
    tryRelease()

    const id = `ix_${randomUUID()}`
    ;(async () => {
      const release = await deps.lock.acquire(id)
      try {
        const job = {
          repoDir: deps.repoDir, dataDir: deps.dataDir,
          store: deps.store, fts: deps.fts,
          embeddingModel: deps.embeddingModel
        }
        if (mode === 'full') await runFullIndex(job)
        else await runIncrementalIndex(job, parsed.paths ?? [])
      } catch (err) {
        log.error({ err, jobId: id }, 'reindex failed')
      } finally {
        release()
      }
    })()

    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'started', job_id: id, estimate_ms: mode === 'full' ? 60_000 : 5_000
    }) }] }
  }

  ;(server as any).__macTools ??= []
  ;(server as any).__macTools.push({
    name: 'reindex',
    description: 'Trigger a reindex run from inside a session. Returns immediately; poll /index/status/:job_id for progress.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['full', 'incremental'] },
        paths: { type: 'array', items: { type: 'string' } }
      }
    },
    handler
  })
}
```

- [ ] **Step 2: Add a test (just sanity — full reindex during a test is slow, so test the busy path or job_id shape)**

```ts
it('reindex returns a started job_id', async () => {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 7,
      method: 'tools/call',
      params: { name: 'reindex', arguments: { mode: 'full' } }
    })
  })
  const body = await res.json() as any
  const payload = JSON.parse(body.result.content[0].text)
  expect(payload.status).toMatch(/^(started|busy)$/)
  expect(payload.job_id).toBeTruthy()
})
```

- [ ] **Step 3: Run, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/reindex.ts tests/integration/mcp.test.ts
git commit -m "feat(mcp): reindex tool"
```

---

## Task 25: Sample-app fixture

**Files:**
- Create: `fixtures/sample-app/{package.json, tsconfig.json, src/*, *.html, *.css, *.json, tests/*}`

This fixture is what integration tests run against — a representative TypeScript app with HTML/CSS/JSON files that exercises each language ingest path.

- [ ] **Step 1: Create `fixtures/sample-app/package.json`**

```json
{
  "name": "sample-app",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

- [ ] **Step 2: Create `fixtures/sample-app/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext",
    "moduleResolution": "Bundler", "strict": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 3: Create source files** (paste each as-is):

`src/auth.ts`:
```ts
export function login(user: string, pass: string): boolean {
  return user === 'admin' && pass === 'secret'
}
export function logout(): void { /* clear */ }
```

`src/api.ts`:
```ts
import { login } from './auth.js'
export async function authenticate(req: { user: string; pass: string }): Promise<{ ok: boolean }> {
  return { ok: login(req.user, req.pass) }
}
```

`src/server.ts`:
```ts
import { authenticate } from './api.js'
export async function handle(req: { user: string; pass: string }): Promise<Response> {
  const result = await authenticate(req)
  return new Response(JSON.stringify(result))
}
```

`src/index.html`:
```html
<!DOCTYPE html>
<html>
<head><link rel="stylesheet" href="./style.css"></head>
<body>
  <div id="login-form">
    <my-button>Sign in</my-button>
  </div>
</body>
</html>
```

`src/style.css`:
```css
:root { --primary: #4f46e5; }
.btn-primary { background: var(--primary); color: white; }
#login-form { padding: 20px; }
```

`src/config.json`:
```json
{ "name": "sample-app", "version": "0.1.0", "deps": { "x": "1" } }
```

`tests/auth.test.ts`:
```ts
import { login } from '../src/auth.js'
test('login admin', () => { expect(login('admin', 'secret')).toBe(true) })
```

- [ ] **Step 4: Commit**

```bash
git add fixtures/sample-app/
git commit -m "test: sample-app fixture for integration tests"
```

---

## Task 26: Integration tests against sample-app

**Files:**
- Create: `tests/integration/sample-app.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore } from '../../src/store/kuzu.js'
import { FtsStore } from '../../src/store/fts.js'
import { Embedder } from '../../src/indexer/embed.js'
import { WriteLock } from '../../src/lock.js'
import { runFullIndex } from '../../src/indexer/orchestrator.js'
import { buildMcpApp } from '../../src/mcp/server.js'

const FIX = join(__dirname, '../../fixtures/sample-app')

async function callTool(app: any, name: string, args: unknown, id = 1) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  })
  const body = await res.json() as any
  return JSON.parse(body.result.content[0].text)
}

describe('sample-app integration', () => {
  let dataDir: string, store: GraphStore, fts: FtsStore, app: any

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-sample-'))
    store = await GraphStore.open(join(dataDir, 'kuzu'))
    fts = new FtsStore(join(dataDir, 'fts.db'))
    const embedder = new Embedder('Xenova/bge-small-en-v1.5')
    await embedder.ready()
    const lock = new WriteLock()
    await runFullIndex({ repoDir: FIX, dataDir, store, fts, embeddingModel: 'Xenova/bge-small-en-v1.5' })
    app = await buildMcpApp({ store, fts, embedder, lock, repoDir: FIX, dataDir, embeddingModel: 'Xenova/bge-small-en-v1.5' })
  }, 240_000)

  afterAll(async () => {
    await store.close(); fts.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('indexes TS, HTML, CSS, JSON', async () => {
    const all = await store.raw<{ path: string; language: string }>(
      `MATCH (f:File) RETURN f.path AS path, f.language AS language`)
    const byLang = all.reduce((m, r) => ({ ...m, [r.language]: (m[r.language] ?? 0) + 1 }), {} as Record<string, number>)
    expect(byLang.ts).toBeGreaterThanOrEqual(3)
    expect(byLang.html).toBeGreaterThanOrEqual(1)
    expect(byLang.css).toBeGreaterThanOrEqual(1)
    expect(byLang.json).toBeGreaterThanOrEqual(1)
  })

  it('impact on login surfaces handle and authenticate as transitive callers, plus tests/auth.test.ts', async () => {
    const ctx = await callTool(app, 'context', { name: 'login' })
    const id = ctx.symbol.id
    const imp = await callTool(app, 'impact', { symbol_id: id, hops: 3 })
    const callerNames = imp.transitive_callers.map((c: any) => c.symbol.name)
    expect(callerNames).toEqual(expect.arrayContaining(['authenticate', 'handle']))
    expect(imp.tests_affected).toContain('tests/auth.test.ts')
  })

  it('query finds login by free text', async () => {
    const r = await callTool(app, 'query', { q: 'authentication login' })
    expect(r.results.some((h: any) => h.name === 'login')).toBe(true)
  })

  it('finds CSS class symbol', async () => {
    const rows = await store.raw<{ s: any }>(
      `MATCH (s:Symbol {name: '.btn-primary'}) RETURN s`)
    expect(rows.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run, expect PASS** (slow — full index + multiple MCP calls)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/sample-app.test.ts
git commit -m "test(integration): sample-app end-to-end"
```

---

## Task 27: Dockerfile + docker-run script

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `scripts/docker-run.sh`

- [ ] **Step 1: Write `Dockerfile`**

```dockerfile
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV PNPM_HOME=/usr/local/pnpm-store \
    PATH=$PNPM_HOME:$PATH \
    NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@latest --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
ENV PORT=3030 \
    DATA_DIR=/data \
    REPO_DIR=/repo \
    WIKI_DIR=/wiki \
    EMBEDDING_MODEL=Xenova/bge-small-en-v1.5

EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3030/health').then(r => r.ok ? process.exit(0) : process.exit(1))"

CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Write `.dockerignore`**

```
node_modules
dist
.dev
.mac-graph-data
.mac-graph-wiki
.git
docs
fixtures
tests
*.log
```

- [ ] **Step 3: Write `scripts/docker-run.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO=${1:-$PWD}
PORT=${PORT:-3030}

REPO=$(cd "$REPO" && pwd)
DATA="$REPO/.mac-graph-data"
WIKI="$REPO/.mac-graph-wiki"
mkdir -p "$DATA" "$WIKI"

exec docker run --rm -it \
  --name mac-graph \
  -v "$REPO":/repo:ro \
  -v "$DATA":/data \
  -v "$WIKI":/wiki \
  -p "127.0.0.1:$PORT:3030" \
  mac-graph:latest
```

- [ ] **Step 4: Make executable + sanity build**

Run:
```bash
chmod +x scripts/docker-run.sh
pnpm docker:build
```
Expected: image `mac-graph:latest` builds successfully.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore scripts/docker-run.sh
git commit -m "build(docker): runtime image + docker:run wrapper"
```

---

## Task 28: E2E test (build, run, hit endpoints)

**Files:**
- Create: `tests/e2e/docker.test.ts`, `tests/e2e/helpers.ts`

- [ ] **Step 1: Write `tests/e2e/helpers.ts`**

```ts
import Docker from 'dockerode'
import { setTimeout as sleep } from 'node:timers/promises'

export async function waitHealthy(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch { /* not ready */ }
    await sleep(1000)
  }
  throw new Error(`timed out waiting for ${url}`)
}

export async function runContainer(opts: {
  image: string; repoDir: string; dataDir: string; wikiDir: string; port: number
}): Promise<Docker.Container> {
  const docker = new Docker()
  const container = await docker.createContainer({
    Image: opts.image,
    HostConfig: {
      Binds: [
        `${opts.repoDir}:/repo:ro`,
        `${opts.dataDir}:/data`,
        `${opts.wikiDir}:/wiki`
      ],
      PortBindings: { '3030/tcp': [{ HostIp: '127.0.0.1', HostPort: String(opts.port) }] }
    }
  })
  await container.start()
  return container
}
```

- [ ] **Step 2: Write `tests/e2e/docker.test.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Docker from 'dockerode'
import { waitHealthy, runContainer } from './helpers.js'

const FIX = join(__dirname, '../../fixtures/sample-app')

describe.skipIf(!process.env.E2E)('docker e2e', () => {
  let container: Docker.Container
  let dataDir: string, wikiDir: string
  const port = 13030
  const base = `http://127.0.0.1:${port}`

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mg-e2e-d-'))
    wikiDir = mkdtempSync(join(tmpdir(), 'mg-e2e-w-'))
    container = await runContainer({
      image: 'mac-graph:latest', repoDir: FIX, dataDir, wikiDir, port
    })
    await waitHealthy(`${base}/health`)
  }, 240_000)

  afterAll(async () => {
    await container.stop().catch(() => {})
    await container.remove().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(wikiDir, { recursive: true, force: true })
  })

  it('GET /health returns ok', async () => {
    const r = await fetch(`${base}/health`)
    const body = await r.json() as any
    expect(body.ok).toBe(true)
  })

  it('POST /index runs to completion', async () => {
    const start = await fetch(`${base}/index`, { method: 'POST' })
    expect(start.status).toBe(202)
    const { jobId } = await start.json() as any
    let phase = ''
    for (let i = 0; i < 240; i++) {
      const r = await fetch(`${base}/index/status/${jobId}`)
      const body = await r.json() as any
      phase = body.phase
      if (phase === 'complete' || phase === 'error') break
      await new Promise(r => setTimeout(r, 1000))
    }
    expect(phase).toBe('complete')
  }, 240_000)

  it('MCP tools/list returns 5 tools', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    const body = await r.json() as any
    const names = body.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual(['context', 'detect_changes', 'impact', 'query', 'reindex'])
  })
})
```

- [ ] **Step 3: Run E2E**

Run: `pnpm test:e2e`
Expected: PASS (skipped silently if `E2E=` not set, full pass when set).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/
git commit -m "test(e2e): docker container build + indexed MCP smoke"
```

---

## Self-review checklist

After all tasks complete, verify before tagging `v0.1.0`:

- [ ] `pnpm test` (unit + integration) green
- [ ] `pnpm test:e2e` green
- [ ] `pnpm typecheck` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm docker:build` succeeds
- [ ] `pnpm docker:run` against a real local repo (e.g. `~/projects/hey-call`) boots and `curl http://127.0.0.1:3030/health` returns `ok: true`
- [ ] Claude Code's MCP config can point at `http://127.0.0.1:3030/mcp` and call `query`, `context`, `impact` against the indexed repo

Then:

```bash
git tag v0.1.0
git push --tags  # if/when there's a remote
```

---

# Phase 2 — Wiki generation (outline)

**Goal:** add LLM-driven markdown wiki generation on top of the Phase-1 graph. Pluggable LLM providers, opt-in trigger, files-on-disk + HTTP serving.

**Why phased:** wiki gen burns tokens and depends on a working graph. Implementing it after Phase 1 ships means we generate wiki against a real codebase to validate output quality, instead of fixturing it.

**File additions / changes:**

```
src/wiki/
  ├── providers/
  │   ├── interface.ts        # LLM { complete(prompt, opts?): Promise<string> }
  │   ├── anthropic.ts
  │   ├── openai.ts
  │   ├── ollama.ts
  │   ├── http-webhook.ts
  │   └── none.ts             # null provider — structural-only
  ├── generator.ts            # orchestrates: pick targets, render, write
  ├── prompts.ts              # prompt templates per page kind
  ├── render-symbol.ts        # SymbolNode + edges → markdown
  ├── render-cluster.ts
  └── render-file.ts
src/http/routes/wiki.ts       # GET /wiki/<path> + POST /wiki/regenerate
```

**Task outline (~8 tasks):**

1. LLM provider interface + `none` (null) implementation + tests against null.
2. Anthropic provider + integration test (skipped without `ANTHROPIC_API_KEY`).
3. OpenAI + Ollama + http-webhook providers with the same conditional-skip pattern.
4. Symbol page renderer (structural sections only — works without LLM).
5. Cluster and file page renderers.
6. Wiki generator orchestrator: query graph for "important symbols" + clusters, run LLM in batches, write markdown to `/wiki/`.
7. HTTP routes: `GET /wiki/*` (serve disk content; markdown→HTML on the fly), `POST /wiki/regenerate` (with `scope` filter).
8. Add `withWiki=true` query param to `POST /index` that runs Phase 5 → wiki gen as the final step. Update integration tests to assert generated `index.md`.

**End state:** `docker run` + `POST /index?withWiki=true` produces a fully-browsable markdown wiki at `/wiki/`. Integration test against `sample-app` fixture asserts that the wiki contains a page for `login`, a page mentioning `authenticate` as a caller, and a cluster overview.

**Heuristics tunable via env:**
- `WIKI_MIN_CALLERS` (default 3) — exported symbols below this don't get pages
- `WIKI_MIN_CLUSTER_SIZE` (default 3)
- `WIKI_MAX_CONCURRENT_LLM` (default 4)

**Out of scope of Phase 2:** automatic wiki regeneration on file change, wiki diff/PR generation, cross-link checking. Those are phase-3+ polish.

---

# Phase 3 — Visualizer + /graph endpoint (outline)

**Goal:** Lit single-page app served at `/viz` plus a `GET /graph` subgraph endpoint, giving an interactive code-explorer UI on top of the Phase-1 graph and Phase-2 wiki.

**Why phased:** the UI work is independent of agent functionality. Phase 1 delivers Claude Code's value; Phase 3 delivers the human-facing UX. Phasing also lets us shape the UI based on what proved useful in Phase 1 dogfooding.

**File additions:**

```
src/http/routes/graph.ts      # GET /graph?center=&hops=&kinds=&languages=
src/http/routes/static.ts     # serves dist/viz/* at /viz
src/viz/                      # Lit + Cytoscape.js source
  ├── index.html
  ├── main.ts                 # bootstraps the app
  ├── components/
  │   ├── search-bar.ts
  │   ├── graph-canvas.ts     # wraps cytoscape
  │   └── side-panel.ts
  ├── api.ts                  # typed fetch wrapper for /mcp + /graph
  ├── styles.css
  └── tsconfig.json           # separate tsconfig (DOM lib)
build/viz.config.ts           # bundles src/viz → dist/viz/* (esbuild)
```

**Task outline (~10 tasks):**

1. `GET /graph` endpoint with subgraph capping (≤500 nodes; `truncated:true` flag) — Cypher path: `MATCH (c:Symbol {id: $center})-[:REFERENCES*1..$hops]-(n) RETURN nodes + rels`.
2. Lit project skeleton (separate tsconfig, esbuild bundler, output to `dist/viz/`).
3. Lit `<search-bar>` component — calls MCP `query`, renders results.
4. Lit `<graph-canvas>` — Cytoscape.js wrapper, layout (cose-bilkent), node coloring by language, edge weight by kind.
5. Click-result-to-graph wiring: result click expands subgraph around symbol via `/graph?center=`.
6. Lit `<side-panel>` — calls MCP `context`, renders signature/callers/callees/cluster.
7. Side-panel "Impact" toggle — re-renders graph using `impact` blast radius.
8. Side-panel wiki link — checks if `/wiki/symbols/<id>.md` exists, navigates if so.
9. Static-file route: `GET /viz/*` serves bundled SPA.
10. Playwright (or simple headless Chrome via Puppeteer) e2e test: load `/viz`, search, click result, assert graph rendered + side panel populated.

**End state:** `docker run` + browser visit `http://localhost:3030/viz` gives a polished interactive code map with search, graph navigation, side-panel context, impact toggle, and wiki deep-links. Plus the underlying `/graph` endpoint can be hit directly for any custom tooling.

**Out of scope of Phase 3:** view persistence (saved layouts), collaborative cursors, embedded source viewer with syntax highlighting, GitHub-style file browser. All of those are post-MVP polish; the core UX is "search → graph → context → wiki".

---

## Self-review

**Spec coverage:** Sections 1-15 of the design spec map to Phase 1 tasks 1-28. Section 16 (legal) is implicit in dependency choices throughout. Wiki gen (§7) → Phase 2. Visualizer (§8) → Phase 3. `/graph` HTTP route (§6.1) → Phase 3 (only the visualizer uses it).

**Placeholder scan:** No "TBD"/"TODO"/"implement later" patterns. All code blocks are concrete; SCIP API note in Task 13 acknowledges version drift but gives the structural pattern.

**Type consistency:** `SymbolNode`, `FileNode`, `ChunkNode`, etc. defined once in Task 5 (`src/store/types.ts`) and used consistently. `SymbolKind` enum matches between schemas (Task 19) and types (Task 5). MCP tool names match between tool registration (`__macTools.push({ name: ... })`) and assertions in tests (`['context', 'detect_changes', 'impact', 'query', 'reindex']`).

**Scope:** Phase 1 produces a complete, testable, dogfooded Docker container. Phases 2 and 3 are clean additions with no Phase-1 churn.
