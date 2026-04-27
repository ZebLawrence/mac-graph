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
  log.warn({ changedPaths }, 'incremental falls back to full reindex in Phase 1')
  return runFullIndex(job)
}
